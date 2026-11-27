import type { Migration } from './types.js';

/**
 * 补列：tasks.updated_at。
 * 历史行没有「最后改动」概念，用 created_at 兜 —— 别让迁移当天变成全员更新。
 */
export const migration: Migration = {
    id: 'tasks-updated-at',
    title: '补列：tasks.updated_at',
    plan: {
        from: 'tasks',
        to: '+ updated_at',
        note: '用 created_at 回填',
        rows: (rt) => (rt.hasTable('tasks') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n : -1),
    },
    done: (rt) => rt.columns('tasks').has('updated_at'),
    up: (rt) => {
        rt.db.exec('ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
        rt.db.prepare('UPDATE tasks SET updated_at = created_at WHERE updated_at = 0').run();
    },
};
