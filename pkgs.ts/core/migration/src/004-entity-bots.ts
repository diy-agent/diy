import type { Migration } from './types.js';

/** 老的 entity_bots（只有 id 列表）→ room_members（第一位为 primary）。 */
export const migration: Migration = {
    id: 'entity-bots-to-room-members',
    title: '老表 entity_bots → room_members',
    plan: {
        from: 'entity_bots',
        to: 'room_members',
        note: '老的成员 id 列表展开成行',
        rows: (rt) =>
            rt.hasTable('entity_bots') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM entity_bots').get() as { n: number }).n : -1,
    },
    done: (rt) => !rt.hasTable('entity_bots'),
    up: (rt) => {
        const count = (rt.db.prepare('SELECT COUNT(*) AS n FROM room_members').get() as { n: number }).n;
        if (count === 0) {
            const rows = rt.db
                .prepare('SELECT entity_id, bot_id, position FROM entity_bots ORDER BY entity_id, position')
                .all() as Array<Record<string, unknown>>;
            const insert = rt.db.prepare(
                'INSERT OR IGNORE INTO room_members (entity_id, bot_id, position, primary_flag) VALUES (?,?,?,?)',
            );
            for (const row of rows) {
                insert.run(
                    String(row['entity_id']),
                    String(row['bot_id']),
                    Number(row['position']),
                    Number(row['position']) === 0 ? 1 : 0,
                );
            }
        }
        rt.db.exec('DROP TABLE entity_bots');
    },
};
