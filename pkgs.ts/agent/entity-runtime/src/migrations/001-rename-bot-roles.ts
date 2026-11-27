import type { Migration } from './types.js';

/**
 * 表改名（2026-11-27）：bot_roles → bot_profiles。
 *
 * 必须在建表之前跑 —— 否则新表先被建出来，老表就再也改不了名（旧数据会变成孤儿）。
 * 索引不能改名，直接丢掉重建。
 */
export const migration: Migration = {
    id: 'rename-bot-roles',
    title: '表名：bot_roles → bot_profiles',
    plan: {
        from: 'bot_roles',
        to: 'bot_profiles',
        note: '表改名，行数不变',
        rows: (rt) => (rt.hasTable('bot_roles') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM bot_roles').get() as { n: number }).n : -1),
    },
    done: (rt) => !rt.hasTable('bot_roles'),
    up: (rt) => {
        rt.db.exec('ALTER TABLE bot_roles RENAME TO bot_profiles');
        rt.db.exec('DROP INDEX IF EXISTS bot_roles_primary');
        rt.db.exec('DROP INDEX IF EXISTS bot_roles_type');
    },
};
