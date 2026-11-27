import type { Migration } from './types.js';

/** 补列：task_units.parent_id（需求账本树）。历史行没有分解树概念，一律当根。 */
export const migration: Migration = {
    id: 'task-units-parent',
    title: '补列：task_units.parent_id（需求账本树）',
    plan: {
        from: 'task_units',
        to: '+ parent_id',
        note: '补需求树挂点',
        rows: (rt) =>
            rt.hasTable('task_units') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM task_units').get() as { n: number }).n : -1,
    },
    done: (rt) => rt.columns('task_units').has('parent_id'),
    up: (rt) => rt.db.exec('ALTER TABLE task_units ADD COLUMN parent_id TEXT'),
};
