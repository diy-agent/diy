import type { Migration } from './types.js';

/**
 * 补列：task_units.kind（需求 / 步骤两层，2026-11-27 用户裁）。
 *
 * 为什么必须是一条**迁移**而不是只改 `CREATE TABLE`：`CREATE TABLE IF NOT EXISTS`
 * 对已存在的表是不生效的 —— 新库建出来就带 `kind`，老库（生产全是老库）永远缺这一列，
 * 而写入语句列了它 ⇒ **任何 unit 写入都报 `table task_units has no column named kind`**。
 * 2026-11-27 现场：PR #621 加了列、漏了这条迁移，生产上把需求标 done 直接失败。
 *
 * 历史行一律 `need`：它们本来就是「要做什么」，没有步骤概念。
 */
export const migration: Migration = {
    id: 'task-units-kind',
    title: '补列：task_units.kind（需求 / 步骤）',
    plan: {
        from: 'task_units：没有 kind 列',
        to: '+ kind（历史行 = need）',
        note: '需求与步骤分两层',
        rows: (rt) =>
            rt.hasTable('task_units') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM task_units').get() as { n: number }).n : -1,
    },
    done: (rt) => (rt.hasTable('task_units') ? rt.columns('task_units').has('kind') : true),
    up: (rt) => {
        if (!rt.hasTable('task_units')) return;
        if (rt.columns('task_units').has('kind')) return;
        rt.db.exec("ALTER TABLE task_units ADD COLUMN kind TEXT NOT NULL DEFAULT 'need'");
    },
};
