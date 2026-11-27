import type { Migration } from './types.js';

/**
 * 会话键的列名改过两次：`bot_id`（旧）→ `bot_role_id`（2026-11-24）→ `bot_profile_id`（2026-11-27）。
 * 两个旧名都要能改过来 —— 只认一手老库会让中间那一代库启动就 “no such column”。
 */
export const migration: Migration = {
    id: 'session-bot-column',
    title: '列名：session_state.bot_id / bot_role_id → bot_profile_id',
    plan: {
        from: 'session_state.bot_id',
        to: 'session_state.bot_profile_id',
        note: '列名改迁（两代旧名都认）',
        rows: (rt) =>
            rt.hasTable('session_state')
                ? (rt.db.prepare('SELECT COUNT(*) AS n FROM session_state').get() as { n: number }).n
                : -1,
    },
    done: (rt) => rt.columns('session_state').has('bot_profile_id'),
    up: (rt) => {
        const columns = rt.columns('session_state');
        if (columns.has('bot_role_id')) {
            rt.db.exec('ALTER TABLE session_state RENAME COLUMN bot_role_id TO bot_profile_id');
            return;
        }
        rt.db.exec('ALTER TABLE session_state RENAME COLUMN bot_id TO bot_profile_id');
    },
};
