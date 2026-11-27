import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移能用的能力面 —— 由 store 提供，迁移不直接摸 store 内部。
 *
 * 为什么要有这一层：迁移需要的东西分两类 ——
 *  1. **库操作**（查表名 / 查列 / 改名留档）：纯 SQL，迁移自己就能干；
 *  2. **store 语义**（老房间搬家要分配任务编号、要写导出物）：这些不是 SQL，
 *     依赖 store 的其它部件，不能塞进迁移文件里自成一体。
 * 把两类都收进这个接口，迁移只依赖接口，store 负责实现。
 */
export interface MigrationRuntime {
    db: DatabaseSync;
    /**
     * 开事务；**已在事务里就直接跑**（不嵌套）。
     *
     * 为什么要可重入：迁移器会包一层事务保证「执行 + 记账」原子，
     * 而里面搬家的代码（writeTask）平时自己也开事务 —— 不处理嵌套会撞 BEGIN。
     */
    transaction<T>(fn: () => T): T;
    hasTable(name: string): boolean;
    columns(table: string): Set<string>;
    /** 把老表改名成 `<table>_v0` 留档（改名后原表名就空出来了） */
    renameToBackup(table: string): void;
    /** 当前 schema 的落地（`CREATE TABLE IF NOT EXISTS` 一整套）—— 003 号迁移用它 */
    createSchema(): void;
    /** 老库 `rooms` 表搬家要走 store 的写入路径（编号分配 / 导出物）—— 迁移只负责触发 */
    legacyRooms(): void;
    /** `bots` → 机器人配置的折叠 —— 同上，涉及会话/消息的重写，属 store 语义 */
    foldBots(): void;
    /** 老 `journal_entries` → 事件流 —— 同上 */
    journalToEvents(): void;
    log(message: string): void;
    /** 长步骤上报子进度（迁移器在每次 up 前挂上，跑完摘掉） */
    progress?(done: number, total: number): void;
}

/** 一条迁移在「迁移计划」里的样子（迁移页据此渲染「旧 → 新」对照表） */
export interface MigrationPlanLine {
    /** 旧资源（表 / 列 / 值） */
    from: string;
    /** 过完这道手续变成什么 */
    to: string;
    /** 一句话解释在干什么 */
    note: string;
    /** 旧资源有多少行；返回 -1 = 这个库里没有它 */
    rows?(runtime: MigrationRuntime): number;
}

export interface Migration {
    /** 稳定 id（= 执行顺序；也是 `schema_migrations` 的主键） */
    id: string;
    /** 给人看的名字（迁移页直接显示） */
    title: string;
    plan: MigrationPlanLine;
    /**
     * 这个库里这一项**现在是否已完成**。
     *
     * 两个用途（同一份判据）：
     *  - 老库基线：首次引入版本表时，老库没有记账，靠它认定「这些早就做过了」，不重放；
     *  - 迁移页状态：不用跑一遍才知道哪些已完成。
     *
     * 判据必须与 `up()` 的跳过条件一致，否则会出现「说做完了其实没做」。
     */
    done(runtime: MigrationRuntime): boolean;
    /**
     * 已记账也要每次启动重新收敛（默认只跑一次）。
     *
     * 区分两类迁移：
     *  - **历史转换**（表改名、折叠）：一次性，跑过就是跑过，不重复。
     *  - **不变量**（清占位值这类数据归一）：`done()` 就是一个便宜的查询，
     *    每次启动如果发现又不对了就再扭一遍 —— 代价小，但少了它就靠「别写进去」自律。
     */
    converge?: boolean;
    up(runtime: MigrationRuntime): void;
}

/** 一步迁移的进度事件（迁移页逐条显示） */
export interface MigrationStepEvent {
    id: string;
    title: string;
    state: 'running' | 'done' | 'skipped' | 'failed';
    changes?: number;
    note?: string;
    durationMs?: number;
    /** 同一步内的子进度（长步骤用，页面画成 n/m） */
    progress?: { done: number; total: number };
}

export type MigrationReporter = (event: MigrationStepEvent) => void;
