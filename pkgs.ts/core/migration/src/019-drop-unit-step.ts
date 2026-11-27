import type { Migration } from './types.js';

/**
 * 退役：`task_units.kind` 的第二档 `step`（2026-11-27 用户裁「砍掉 kind=step」）。
 *
 * 为什么退役（当天上线、当天砍）：018 给 `task_units` 补了 `kind` 列，想让账本分「需求 / 步骤」
 * 两层。上线后体检生产库：**153 条 unit 里 `kind = 'step'` 一条都没有** —— 工具支持、提示词写了
 * 判据，模型仍从不主动标 step。也就是说那一层事实上不存在，留着只会让人以为「步骤有地方记」。
 * 执行过程本来就另有出处：`journal`（决策 / 进展）+ `job` + 工具调用记录。
 *
 * 这条迁移做两件事：
 * 1. 把库里已有的 `kind <> 'need'` 行归位成 `need`（生产是 0 行，dev / 测试库里可能有）——
 *    它们会被当成普通条目显示，由人决定删掉还是留下来。
 * 2. 列本身**不删**：SQLite 删列要重建表，而代码已经完全不读不写它（`DEFAULT 'need'` 兜住老库）。
 *    留着是零成本的死列，删它是高风险的重建 —— 与 011 / 012 同一条取舍。
 */
export const migration: Migration = {
    id: 'drop-unit-step',
    title: '退役：task_units 的 step 档（历史行归位为 need）',
    plan: {
        from: "task_units：kind = 'step' 的历史行",
        to: "kind = 'need'（步骤层退役，只留两层）",
        note: 'kind 列保留（代码不再读写），只把值归位',
        rows: (rt) =>
            rt.hasTable('task_units') && rt.columns('task_units').has('kind')
                ? (rt.db.prepare("SELECT COUNT(*) AS n FROM task_units WHERE kind <> 'need'").get() as { n: number })
                      .n
                : -1,
    },
    done: (rt) => {
        if (!rt.hasTable('task_units')) return true;
        if (!rt.columns('task_units').has('kind')) return true;
        return (rt.db.prepare("SELECT COUNT(*) AS n FROM task_units WHERE kind <> 'need'").get() as { n: number }).n === 0;
    },
    up: (rt) => {
        if (!rt.hasTable('task_units')) return;
        if (!rt.columns('task_units').has('kind')) return;
        rt.db.exec("UPDATE task_units SET kind = 'need' WHERE kind <> 'need'");
    },
};
