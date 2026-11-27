import type { Migration } from './types.js';

/** 表改名（2026-11-27）：role_config → bot_profile_defaults。同样得赶在建表之前。 */
export const migration: Migration = {
    id: 'rename-role-config',
    title: '表名：role_config → bot_profile_defaults',
    plan: {
        from: 'role_config',
        to: 'bot_profile_defaults',
        note: '表改名，行数不变',
        rows: (rt) =>
            rt.hasTable('role_config') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM role_config').get() as { n: number }).n : -1,
    },
    done: (rt) => !rt.hasTable('role_config'),
    up: (rt) => rt.db.exec('ALTER TABLE role_config RENAME TO bot_profile_defaults'),
};
