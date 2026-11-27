import type { Migration } from './types.js';

/**
 * 老 `rooms`（一个 data JSON 袋子）→ entities + tasks / projects。
 *
 * 实现留在 store：搬家要走**写入路径**（任务编号分配、导出物落盘），
 * 那不是 SQL 能表达的事。迁移只负责「什么时候做、做完没有」。
 */
export const migration: Migration = {
    id: 'legacy-rooms',
    title: '老表 rooms → rooms_v0 + 实体 / 域行',
    plan: {
        from: 'rooms',
        to: 'rooms_v0 + 实体 / 域行',
        note: '老房间表搬家后留档',
        rows: (rt) => (rt.hasTable('rooms') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n : -1),
    },
    done: (rt) => !rt.hasTable('rooms'),
    up: (rt) => rt.legacyRooms(),
};
