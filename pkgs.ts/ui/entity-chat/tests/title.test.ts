// roomTitle —— 名字跟着容器走（Room 自己没有 name）。
//
// 这个函数是 UI 侧唯一的名字入口：侧栏、房间头、历史、弹窗都问它。
// 老数据没有 `title`（合并前任务名在 room.name、一句话描述在 data.desc），
// 所以兜底顺序本身就是要测的东西。

import { describe, expect, it } from 'vitest';

import { roomTitle, type Bot, type Room } from '../src/model';

const bot = (name: string): Bot => ({
    id: 'bot-1',
    name,
    color: '',
    persona: '',
    homeRoomId: 'home',
    modelKey: 'm',
});

function room(over: Partial<Room>): Room {
    return { id: 'room-1', type: 'task', data: {}, members: [], modelKey: 'm', ...over };
}

describe('roomTitle', () => {
    it('task 用 data.title（编号只做句柄，不进名字）', () => {
        expect(roomTitle(room({ data: { title: '接工作台进 diy2', number: 14 } }))).toBe('接工作台进 diy2');
    });

    it('project 用 data.name', () => {
        expect(roomTitle(room({ type: 'project', data: { name: 'diy', dir: '~/git/diy/diy' } }))).toBe('diy');
    });

    it('老任务只有 desc 时用它兜底（合并前的那一句话描述）', () => {
        expect(roomTitle(room({ data: { status: 'open', desc: '旧的一句话描述' } }))).toBe('旧的一句话描述');
    });

    it('title 优先于 desc：合并后两者可能短暂共存', () => {
        expect(roomTitle(room({ data: { title: '新标题', desc: '旧的描述' } }))).toBe('新标题');
    });

    it('通用容器（stock 之类）没有名字键时退到主成员 bot 名', () => {
        const stock = room({
            type: 'stock',
            data: { symbol: '600519' },
            members: [{ botId: 'bot-1', primary: true }],
        });
        expect(roomTitle(stock, { 'bot-1': bot('茅台观察员') })).toBe('茅台观察员');
    });

    it('没传 bots 或没主成员时退 id（插件容器可能不取名）', () => {
        const stock = room({ type: 'stock', data: { symbol: '600519' } });
        expect(roomTitle(stock)).toBe('room-1');
        expect(roomTitle(stock, { 'bot-1': bot('没人认领') })).toBe('room-1');
    });

    it('空白名字不算名字（空串 / 纯空格都跳过）', () => {
        expect(roomTitle(room({ data: { title: '   ', name: 'diy' } }))).toBe('diy');
    });
});
