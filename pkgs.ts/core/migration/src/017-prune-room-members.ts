import type { Migration } from './types.js';

/**
 * 房间成员收敛到「主 bot 一个」（2026-11-27 用户：房间只留任务/项目主 bot）。
 *
 * 为什么这张表要清：房间成员**运行时是派生的**（`membersOfType` → 该类型的主 bot），
 * 而 `room_members` 是建房时写下的快照 —— 快照还留着「类型下全部角色」那 3~4 行。
 * 现在没有读它的调用方，但它留着就是一份与现实对不上的数据（下次谁捡起来读就踩坑）。
 *
 * **不做 converge**：会议（meeting-room）以后会真的往房间拉人，那时多成员是合法状态，
 * 每次启动再把人删了就成 bug 了。这是一次性归一。
 */
export const migration: Migration = {
    id: 'prune-room-members',
    title: '房间成员收敛到主 bot 一个',
    plan: {
        from: 'room_members：每个房间 3~4 行（该类型下的全部角色）',
        to: '每个房间 1 行（该类型的主 bot）',
        note: '单聊：房间只留主 bot',
        rows: (rt) => {
            if (!rt.hasTable('room_members')) return -1;
            const row = rt.db.prepare('SELECT COUNT(*) AS n FROM room_members').get() as { n: number };
            return row.n;
        },
    },
    done: (rt) => {
        if (!rt.hasTable('room_members')) return true;
        // 判据与 up 的跳过条件一致：没有「一个房间多于一行」的就完事
        const row = rt.db
            .prepare('SELECT COUNT(*) AS n FROM (SELECT entity_id FROM room_members GROUP BY entity_id HAVING COUNT(*) > 1)')
            .get() as { n: number };
        return row.n === 0;
    },
    up: (rt) => {
        // 每个房间只留一行：primary_flag 优先，其次 position 最靠前的
        rt.db.exec(`
            DELETE FROM room_members
            WHERE rowid NOT IN (
                SELECT rowid FROM (
                    SELECT rowid,
                           ROW_NUMBER() OVER (
                               PARTITION BY entity_id
                               ORDER BY primary_flag DESC, position ASC, rowid ASC
                           ) AS rn
                    FROM room_members
                ) WHERE rn = 1
            )
        `);
        const left = rt.db.prepare('SELECT COUNT(*) AS n FROM room_members').get() as { n: number };
        const rooms = rt.db.prepare('SELECT COUNT(DISTINCT entity_id) AS n FROM room_members').get() as { n: number };
        rt.log(`房间成员表收敛到 ${String(left.n)} 行 / ${String(rooms.n)} 个房间`);
    },
};
