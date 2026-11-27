import type { Migration } from './types.js';

/** 老库补列：session_state.log_seq（回放水位）。 */
export const migration: Migration = {
    id: 'session-log-seq',
    title: '补列：session_state.log_seq（回放水位）',
    plan: {
        from: 'session_state',
        to: '+ log_seq',
        note: '补回放水位列',
        rows: (rt) =>
            rt.hasTable('session_state')
                ? (rt.db.prepare('SELECT COUNT(*) AS n FROM session_state').get() as { n: number }).n
                : -1,
    },
    done: (rt) => rt.columns('session_state').has('log_seq'),
    up: (rt) => rt.db.exec('ALTER TABLE session_state ADD COLUMN log_seq INTEGER NOT NULL DEFAULT 0'),
};
