import type { DatabaseSync } from 'node:sqlite';

import { migrations } from './index-list.js';
import type { MigrationRuntime } from './types.js';

/** 库现在是什么版本：已记账多少条 / 一共多少条迁移 */
export interface MigrationVersion {
    applied: number;
    total: number;
}

/**
 * 「这个库是什么版本」—— 读 `schema_migrations`。
 *
 * 没有这张表（从没跑过迁移的老库）当 0 算，不报错。
 */
export function migrationVersion(db: DatabaseSync): MigrationVersion {
    const total = migrations.length;
    try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
        return { applied: row.n, total };
    } catch {
        return { applied: 0, total };
    }
}

/** 一条计划项：旧资源 → 新资源 + 现在做完没有 */
export interface MigrationPlanItem {
    /** 负责它的迁移 id（计划行与执行步骤靠它对齐） */
    step: string;
    from: string;
    to: string;
    note: string;
    /** 源有多少行；-1 = 这个库里没有 */
    rows: number;
    /** 库里现在是不是已经完成 */
    done: boolean;
}

/**
 * 只读地把「迁移计划 + 当前状态」算出来（迁移页用）。
 *
 * 只调 `done()`，**从不调 `up()`** —— 所以页面刷新再多次也不会动库。
 * 状态的真源是库本身，不是「点了没点过按钮」：一个早就迁完的库，
 * 打开页面就该显示「已经是迁移后的状态」。
 */
export function migrationPlan(db: DatabaseSync): MigrationPlanItem[] {
    const notForRead = (): never => {
        throw new Error('迁移计划是只读的：这里不该调写操作');
    };
    const runtime: MigrationRuntime = {
        db,
        transaction: <T>(fn: () => T): T => fn(),
        hasTable: (name: string): boolean =>
            db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined,
        columns: (table: string): Set<string> => {
            const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(table);
            if (exists === undefined) return new Set();
            return new Set(
                (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
            );
        },
        renameToBackup: notForRead,
        createSchema: notForRead,
        legacyRooms: notForRead,
        foldBots: notForRead,
        journalToEvents: notForRead,
        log: (): void => undefined,
    };

    return migrations.map((migration) => ({
        step: migration.id,
        from: migration.plan.from,
        to: migration.plan.to,
        note: migration.plan.note,
        rows: migration.plan.rows?.(runtime) ?? -1,
        done: migration.done(runtime),
    }));
}
