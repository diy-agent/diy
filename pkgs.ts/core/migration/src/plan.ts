import type { DatabaseSync } from 'node:sqlite';

import { migrations } from './index-list.js';
import type { MigrationRuntime } from './types.js';

/** 库现在是什么版本：已记账多少条 / 一共多少条迁移 */
export interface MigrationVersion {
    /** **代码里**的迁移，库里已记账的条数 */
    applied: number;
    /** 代码里一共多少条 */
    total: number;
    /**
     * 库里记了账、但代码里已经没有的 id。
     *
     * 出现它的唯一原因是「库跑过别的分支 / 版本的迁移」：切分支回来、或某个迁移被删。
     * 这不是「待迁移」，不能拿来卡启动 —— 只配一句警告。
     */
    unknown: string[];
}

/** 库里记了账的迁移 id（没有版本表 = 空集，不报错） */
function recordedIds(db: DatabaseSync): Set<string> {
    try {
        const rows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
        return new Set(rows.map((row) => row.id));
    } catch {
        return new Set();
    }
}

/**
 * 「这个库是什么版本」—— 读 `schema_migrations`。
 *
 * 没有这张表（从没跑过迁移的老库）当 0 算，不报错。
 * 只数**代码里认得的 id**：库里多出来的账不算「已迁」（否则会出现 17/16 这种数）。
 */
export function migrationVersion(db: DatabaseSync): MigrationVersion {
    const total = migrations.length;
    const recorded = recordedIds(db);
    const known = new Set(migrations.map((migration) => migration.id));
    return {
        applied: migrations.filter((migration) => recorded.has(migration.id)).length,
        total,
        unknown: [...recorded].filter((id) => !known.has(id)).sort(),
    };
}

/**
 * 还差哪些迁移（**按版本表**：代码里有、库里没记账的 id）。
 *
 * 启动闸门只认它 —— 不看 `done()`。为什么这是关键：
 * `done()` 是**数据体检**（「这张表还在吗」「还有占位值吗」），它回答的是「数据长得像不像迁过了」，
 * 而版本表回答的是「这条迁移跑过没有」。两者会分叉，最典型的是：
 *   · 一条已经记账的迁移，数据后来又变回 `done() === false`（新人建的房间、数据被回滚）
 *     → 用 `done()` 判「有待迁移」，页面永远停在迁移页，而点「开始迁移」又会被 run() 跳过
 *       （已记账的非 converge 迁移不重跑）→ **人真卡死，无解**；
 *   · converge 类（不变量）本来就该每次启动复查，它永远不该卡启动。
 * 所以：**版本表管「要不要拦」，`done()` 只管「划线要不要重放」（见 run.ts 的基线）。
 */
export function missingMigrations(db: DatabaseSync): string[] {
    const recorded = recordedIds(db);
    return migrations.filter((migration) => !recorded.has(migration.id)).map((migration) => migration.id);
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
    /** 库里现在是不是已经完成（**数据体检**：给「旧资源还有多少」用，不是启动判据） */
    done: boolean;
    /** 版本表里有没有它（**这才是「迁没迁」的真源**） */
    recorded: boolean;
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

    const recorded = recordedIds(db);
    return migrations.map((migration) => ({
        step: migration.id,
        from: migration.plan.from,
        to: migration.plan.to,
        note: migration.plan.note,
        rows: migration.plan.rows?.(runtime) ?? -1,
        done: migration.done(runtime),
        recorded: recorded.has(migration.id),
    }));
}
