import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db';
import type { Room } from '../src/types';

const room: Room = {
    id: 'task-abc',
    type: 'task',
    name: '新任务 2',
    data: { projectId: 'proj:diy', dir: '~/git/diy/diy' },
    members: [{ botId: 'b1', primary: true }, { botId: 'b2' }],
    modelKey: 'm',
};

describe('rooms 持久化', () => {
    it('saveRoom → listRooms 回到同样的元数据（含成员）', () => {
        const store = openStore(':memory:');
        store.setMembers(room.id, room.members);
        store.saveRoom(room);
        const [saved] = store.listRooms();
        expect(saved).toEqual(room);
    });

    it('改名 / 换模型是 upsert，不会多出一行', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.saveRoom({ ...room, name: '改名后', modelKey: 'm2' });
        const rooms = store.listRooms();
        expect(rooms).toHaveLength(1);
        expect(rooms[0]).toMatchObject({ name: '改名后', modelKey: 'm2' });
    });

    it('data 坏掉不影响列表（当空对象）', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.db.prepare('UPDATE rooms SET data = ? WHERE id = ?').run('{不是 json', room.id);
        expect(store.listRooms()[0]?.data).toEqual({});
    });
});
