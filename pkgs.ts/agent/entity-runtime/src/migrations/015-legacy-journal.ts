import type { Migration } from './types.js';

/** 老 `journal_entries` → 事件流（events），旧表留档 journal_entries_v0。 */
export const migration: Migration = {
    id: 'legacy-journal',
    title: '把老日志折进 entities',
    plan: {
        from: 'journal_entries',
        to: 'events',
        note: '老日志折进实体事件流',
        rows: (rt) =>
            rt.hasTable('journal_entries')
                ? (rt.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n
                : -1,
    },
    done: (rt) => !rt.hasTable('journal_entries'),
    up: (rt) => rt.journalToEvents(),
};
