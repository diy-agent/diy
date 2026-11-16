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

describe('删除容器', () => {
    it('deleteRoom 连带清掉消息 / 日志 / 成员 / 会话 / 投递（不留孤儿行）', () => {
        const store = openStore(':memory:');
        store.setMembers(room.id, room.members);
        store.saveRoom(room);
        store.appendItem(room.id, {
            id: 'msg-1',
            seq: 0,
            turnId: 't1',
            type: 'chat',
            at: Date.now(),
            status: 'done',
            author: { id: 'human:我', name: '我', color: '#000', role: 'human' },
            data: { text: '一句话' },
        });
        store.appendRoomEntry(room.id, { seq: 1, at: Date.now(), kind: 'notice', text: '结论' });
        store.saveSession(room.id, 'b1', { turn: 1, collapsed: 0, entries: [] });
        store.setDelivery({ roomId: room.id, messageId: 'msg-1', botId: 'b1', state: 'delivered' });

        store.deleteRoom(room.id);

        expect(store.listRooms()).toEqual([]);
        expect(store.itemsOf(room.id)).toEqual([]);
        expect(store.roomEntries(room.id)).toEqual([]);
        expect(store.members()[room.id]).toBeUndefined();
        expect(store.loadSession(room.id, 'b1')).toBeUndefined();
        expect(store.listDeliveries(room.id)).toEqual([]);
    });

    it('deleteBot 只删那一个身份', () => {
        const store = openStore(':memory:');
        store.upsertBot({ id: 'b1', name: 'a', color: '#000', persona: 'p', homeRoomId: 'r', modelKey: 'm' });
        store.upsertBot({ id: 'b2', name: 'b', color: '#111', persona: 'p', homeRoomId: 'r', modelKey: 'm' });
        store.deleteBot('b1');
        expect(store.listBots().map((bot) => bot.id)).toEqual(['b2']);
    });
});
