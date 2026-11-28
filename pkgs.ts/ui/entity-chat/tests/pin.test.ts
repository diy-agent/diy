// pin.test.ts —— 置顶的判据与排布（`data.pinnedAt`）。
//
// 置顶这件事有三处读同一份真相：侧栏顶部那块（`pinnedTasksOf`）、项目树的过滤
// （`visibleInProjectTree`）、行尾那颗按钮的图标与文案（`isPinned`）。三条口径在这里锁住：
//   · 值 = 时刻（不是布尔），后 pin 的在最上面；
//   · 只收任务，已关闭的不算（关掉 = 取消置顶，见 `setRoomStatus`）；
//   · 置顶的任务从项目树 / 未归属里**挪走**（去重），归属改由行上的项目 tag 认。

import { describe, expect, it } from 'vitest';

import { isPinned, pinnedAtOf, pinnedTasksOf, visibleInProjectTree } from '../src/model';
import type { Room } from '../src/model';

function room(id: string, type: string, data: Record<string, unknown> = {}): Room {
    return { id, type, name: id, data, members: [], modelKey: 'm' };
}

describe('pinnedAtOf / isPinned —— 时刻就是状态', () => {
    it('正数时刻算置顶，值原样返回', () => {
        expect(pinnedAtOf(room('a', 'task', { pinnedAt: 1000 }))).toBe(1000);
        expect(isPinned(room('a', 'task', { pinnedAt: 1000 }))).toBe(true);
    });

    it('没有 / 0 / 负数 / 非数 / 布尔 true 都不算置顶（老数据与手改库的兜底）', () => {
        for (const value of [undefined, null, 0, -1, Number.NaN, '1000', true]) {
            const task = room('a', 'task', value === undefined ? {} : { pinnedAt: value });
            expect(pinnedAtOf(task)).toBeUndefined();
            expect(isPinned(task)).toBe(false);
        }
    });
});

describe('pinnedTasksOf —— 只列任务、未关闭、后 pin 的在最上面', () => {
    it('按 pinnedAt 倒序', () => {
        const rooms = [
            room('old', 'task', { status: 'open', pinnedAt: 100 }),
            room('new', 'task', { status: 'open', pinnedAt: 300 }),
            room('mid', 'task', { status: 'open', pinnedAt: 200 }),
        ];
        expect(pinnedTasksOf(rooms).map((item) => item.id)).toEqual(['new', 'mid', 'old']);
    });

    it('已关闭的不进置顶区（归历史任务区）', () => {
        const rooms = [
            room('open', 'task', { status: 'open', pinnedAt: 200 }),
            room('closed', 'task', { status: 'closed', pinnedAt: 300, closedAt: 400 }),
        ];
        expect(pinnedTasksOf(rooms).map((item) => item.id)).toEqual(['open']);
    });

    it('非任务不进来：项目 / 插件容器哪怕 data 里有 pinnedAt 也不算', () => {
        const rooms = [
            room('proj', 'project', { name: 'p', pinnedAt: 500 }),
            room('stock', 'stock', { name: 's', pinnedAt: 400 }),
            room('task', 'task', { status: 'open', pinnedAt: 100 }),
        ];
        expect(pinnedTasksOf(rooms).map((item) => item.id)).toEqual(['task']);
    });

    it('没有 pin / 空列表都是空数组（分组整块不渲染）', () => {
        expect(pinnedTasksOf([])).toEqual([]);
        expect(pinnedTasksOf([room('a', 'task', { status: 'open' })])).toEqual([]);
    });
});

describe('visibleInProjectTree —— 置顶的任务从原位挪走', () => {
    it('未关闭、没 pin 的任务照常留在树里', () => {
        expect(visibleInProjectTree(room('a', 'task', { status: 'open' }))).toBe(true);
    });

    it('已关闭 / 已置顶都不在树里（两处各有一块去处）', () => {
        expect(visibleInProjectTree(room('a', 'task', { status: 'closed' }))).toBe(false);
        expect(visibleInProjectTree(room('a', 'task', { status: 'open', pinnedAt: 1000 }))).toBe(false);
    });

    it('项目 / 其它容器不受影响（pin 只对任务）', () => {
        expect(visibleInProjectTree(room('p', 'project', { name: 'p' }))).toBe(true);
        expect(visibleInProjectTree(room('s', 'stock', { name: 's' }))).toBe(true);
    });
});
