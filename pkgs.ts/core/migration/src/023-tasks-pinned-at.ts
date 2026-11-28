import type { Migration } from './types.js';

/**
 * 补列：tasks.pinned_at —— 侧栏顶部的「置顶」区（2026-11-28）。
 *
 * 存**时刻**而不是 0/1：侧栏按它倒序排（最后 pin 的在最上面），布尔还得另开一列放时刻。
 * 存量行全是 NULL = 没置顶，所以不需要回填 —— 这一步只加列。
 */
export const migration: Migration = {
    id: 'tasks-pinned-at',
    title: '补列：tasks.pinned_at（侧栏置顶）',
    plan: {
        from: 'tasks',
        to: '+ pinned_at',
        note: 'NULL = 没置顶',
        rows: (rt) =>
            rt.hasTable('tasks') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n : -1,
    },
    done: (rt) => rt.columns('tasks').has('pinned_at'),
    up: (rt) => {
        rt.db.exec('ALTER TABLE tasks ADD COLUMN pinned_at INTEGER');
    },
};
