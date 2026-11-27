import { checksumOf } from './checksums.js';
import { migrations } from './index-list.js';
import type { MigrationReporter, MigrationRuntime } from './types.js';

/**
 * 版本表。**这是「这个库是什么版本」的唯一真源。**
 *
 * 为什么必须有它（而不是像以前那样每次启动重新体检一遍）：
 *  - 老迁移永远留在启动路径上，只增不减；
 *  - 库没有版本概念 —— 页面、日志、排障全靠现场推断；
 *  - 没法写非幂等的迁移（「把某列按新规则重算一遍」这种每次重启都会重跑）。
 */
const TABLE = 'schema_migrations';

/**
 * 跑迁移。
 *
 * 顺序：**读已记账 → 跳过跑过的 → 没跑过的先用 `done()` 做一次基线判断
 * → 该跑的在事务里跑（执行 + 记账同进同退）**。
 *
 * 基线（baseline）这一步是老库的入口：我们已经有几十个真实库，
 * 它们在这套版本表出现之前就已经被内联迁移改造过了。给它们重放一遍既慢又危险，
 * 所以只要 `done()` 说「这个状态已经是了」，就直接记为已完成。
 */
/** 本次跑了什么（启动日志用它报一句「库版本」） */
export interface MigrationRunResult {
    /** 一共多少条迁移 */
    total: number;
    /** 这次真正跑了的（不含基线、不含跳过） */
    ran: string[];
    /** 首次引入版本表时按体检判据认定为已完成的 */
    baselined: string[];
}

export function applyMigrations(runtime: MigrationRuntime, report: MigrationReporter): MigrationRunResult {
    const { db } = runtime;
    const ran: string[] = [];
    const baselined: string[] = [];
    db.exec(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            -- 1 = 首次引入版本表时按体检判据认定的基线（没有真正跑过 up）
            baseline INTEGER NOT NULL DEFAULT 0,
            -- 跑过的那一版的文件指纹（Flyway 的 checksum）：改文件不改库 → 启动时比对就发现
            checksum TEXT
        )`,
    );
    // 老库的版本表没有 checksum 列（2026-11-27 之前建的）：补一列，别让整条迁移路径带病跑
    const versionColumns = new Set(
        (db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!versionColumns.has('checksum')) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN checksum TEXT`);
    const applied = new Set(
        (db.prepare(`SELECT id FROM ${TABLE}`).all() as Array<{ id: string }>).map((row) => row.id),
    );

    const record = (id: string, title: string, baseline: boolean): void => {
        db.prepare(
            `INSERT OR REPLACE INTO ${TABLE} (id, title, applied_at, baseline, checksum) VALUES (?,?,?,?,?)`,
        ).run(id, title, Date.now(), baseline ? 1 : 0, checksumOf(id) ?? null);
    };
    // 老库的记账没有指纹（加列之前跑的）：静默补成当前文件指纹 —— 那之前本来就无从比对
    for (const migration of migrations) {
        db.prepare(`UPDATE ${TABLE} SET checksum = ? WHERE id = ? AND checksum IS NULL`).run(
            checksumOf(migration.id) ?? null,
            migration.id,
        );
    }

    for (const migration of migrations) {
        // 已记账 → 默认跳过；但 `converge` 类（不变量，如清占位值）要每次复查
        if (applied.has(migration.id) && !(migration.converge === true && !migration.done(runtime))) continue;
        if (applied.has(migration.id)) {
            // converge 再次跑：不重复记账，直接跑
            const startedAt = Date.now();
            report({ id: migration.id, title: migration.title, state: 'running' });
            runtime.progress = (done, total): void => {
                report({ id: migration.id, title: migration.title, state: 'running', progress: { done, total } });
            };
            try {
                runtime.transaction(() => migration.up(runtime));
                report({ id: migration.id, title: migration.title, state: 'done', durationMs: Date.now() - startedAt });
            } catch (error) {
                report({
                    id: migration.id,
                    title: migration.title,
                    state: 'failed',
                    note: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
            continue;
        }

        // 老库基线：这一项在库里已经是完成状态，只补一行记账，不重放
        if (migration.done(runtime)) {
            runtime.transaction(() => record(migration.id, migration.title, true));
            baselined.push(migration.id);
            report({
                id: migration.id,
                title: migration.title,
                state: 'skipped',
                note: '库里已经是这个状态（记为基线）',
            });
            continue;
        }

        const started = Date.now();
        report({ id: migration.id, title: migration.title, state: 'running' });
        // 长步骤（折叠 bots 要扫几十万行 JSON）靠这个把 n/m 报上去
        runtime.progress = (done, total): void => {
            report({ id: migration.id, title: migration.title, state: 'running', progress: { done, total } });
        };
        try {
            runtime.transaction(() => {
                migration.up(runtime);
                record(migration.id, migration.title, false);
            });
            ran.push(migration.id);
            report({
                id: migration.id,
                title: migration.title,
                state: 'done',
                durationMs: Date.now() - started,
            });
        } catch (error) {
            report({
                id: migration.id,
                title: migration.title,
                state: 'failed',
                durationMs: Date.now() - started,
                note: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    return { total: migrations.length, ran, baselined };
}

/**
 * 库里已经记了多少条**当前代码认得**的迁移（「库版本」给人看的那个数）。
 *
 * 为什么不是 `COUNT(*)`：库可能跑过别的分支的迁移（切分支回来就留在账上），
 * 直接数行会得到「17/16」这种对不上的版本号。多出来的 id 由
 * `migrationVersion().unknown` 单独报，不混进 applied。
 */
export function appliedCount(runtime: MigrationRuntime): number {
    try {
        const rows = runtime.db.prepare(`SELECT id FROM ${TABLE}`).all() as Array<{ id: string }>;
        const recorded = new Set(rows.map((row) => row.id));
        return migrations.filter((migration) => recorded.has(migration.id)).length;
    } catch {
        return 0;
    }
}
