import type { Migration } from './types.js';

/**
 * 房间级 model_key 退役（2026-11-27）：模型真源只剩机器人配置。
 *
 * 四张表上的 model_key 一起删（`ALTER TABLE ... DROP COLUMN` 不行时退化成清空）。
 */
export const migration: Migration = {
    id: 'drop-legacy-room-model',
    title: '退役房间级 model_key',
    plan: {
        from: 'tasks / projects / rooms_v0 / room_members 的 model_key',
        to: '（删除）',
        note: '模型真源只剩机器人配置',
    },
    done: (rt) => !['tasks', 'projects', 'rooms_v0', 'room_members'].some((table) => rt.columns(table).has('model_key')),
    up: (rt) => {
        for (const table of ['tasks', 'projects', 'rooms_v0', 'room_members']) {
            if (!rt.hasTable(table)) continue;
            if (!rt.columns(table).has('model_key')) continue;
            try {
                rt.db.exec(`ALTER TABLE ${table} DROP COLUMN model_key`);
            } catch {
                // 老 SQLite 删不动列：退化成清空，代码反正不再读它
                rt.db.exec(`UPDATE ${table} SET model_key = ${table === 'room_members' ? 'NULL' : "''"}`);
            }
        }
    },
};
