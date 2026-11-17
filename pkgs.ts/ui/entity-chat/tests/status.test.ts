// 任务状态两态（open / closed）的判据：老数据归一、树里该不该出现、已关闭表怎么排。
//
// 这几个函数是侧栏两处的**同一份真相**（项目树只留 open 的、导航底部「历史任务」按关闭时间倒序），
// 所以在这里锁行为 —— 三态时代留下的 todo / doing / done 必须在读的时候就归位，
// 否则用户升级后会发现「以前标过的 done 又回到树里了」。

import { describe, expect, it } from 'vitest';

import { closedAtOf, closedTasksOf, isClosed, taskStatusOf, toggleTaskStatus, visibleInTree } from '../src/model';
import type { Room } from '../src/model';

function room(id: string, type: string, data: Record<string, unknown> = {}): Room {
    return { id, type, name: id, data, members: [], modelKey: 'm' };
}

describe('taskStatusOf —— 老的三态读的时候归一', () => {
    it('todo / doing 都是 open，done 是 closed', () => {
        expect(taskStatusOf(room('a', 'task', { status: 'todo' }))).toBe('open');
        expect(taskStatusOf(room('b', 'task', { status: 'doing' }))).toBe('open');
        expect(taskStatusOf(room('c', 'task', { status: 'done' }))).toBe('closed');
    });

    it('新值原样返回；没有 status / 乱填的都当 open', () => {
        expect(taskStatusOf(room('a', 'task', { status: 'open' }))).toBe('open');
        expect(taskStatusOf(room('b', 'task', { status: 'closed' }))).toBe('closed');
        expect(taskStatusOf(room('c', 'task'))).toBe('open');
        expect(taskStatusOf(room('d', 'task', { status: '先放着吧' }))).toBe('open');
        expect(taskStatusOf(room('e', 'task', { status: 42 }))).toBe('open');
    });
});

describe('toggleTaskStatus', () => {
    it('两态来回切', () => {
        expect(toggleTaskStatus('open')).toBe('closed');
        expect(toggleTaskStatus('closed')).toBe('open');
    });
});

describe('closedAtOf', () => {
    it('数字才是时刻；缺省 / 0 / 脏值都是 undefined（表里显示「—」）', () => {
        expect(closedAtOf(room('a', 'task', { closedAt: 1700000000000 }))).toBe(1700000000000);
        expect(closedAtOf(room('b', 'task'))).toBeUndefined();
        expect(closedAtOf(room('c', 'task', { closedAt: 0 }))).toBeUndefined();
        expect(closedAtOf(room('d', 'task', { closedAt: '1700000000000' }))).toBeUndefined();
    });
});

describe('visibleInTree —— closed 的任务不進项目树', () => {
    it('关闭的任务藏起来；open 的、以及非任务类型照旧显示', () => {
        expect(visibleInTree(room('a', 'task', { status: 'open' }))).toBe(true);
        expect(visibleInTree(room('b', 'task', { status: 'done' }))).toBe(false);
        expect(visibleInTree(room('c', 'project'))).toBe(true);
        expect(visibleInTree(room('d', 'stock'))).toBe(true);
    });
});

describe('closedTasksOf', () => {
    it('只收已关闭的任务，按关闭时刻倒序，没有 closedAt 的老数据垫底', () => {
        const rooms = [
            room('old', 'task', { status: 'done' }),
            room('k1', 'task', { status: 'closed', closedAt: 1000 }),
            room('k2', 'task', { status: 'closed', closedAt: 3000 }),
            room('open1', 'task', { status: 'open' }),
            room('proj', 'project', { status: 'closed' }),
        ];
        expect(closedTasksOf(rooms).map((item) => item.id)).toEqual(['k2', 'k1', 'old']);
    });

    it('不改入参顺序（filter 出新数组再排）', () => {
        const rooms = [
            room('a', 'task', { status: 'closed', closedAt: 1 }),
            room('b', 'task', { status: 'closed', closedAt: 2 }),
        ];
        closedTasksOf(rooms);
        expect(rooms.map((item) => item.id)).toEqual(['a', 'b']);
    });
});

describe('isClosed', () => {
    it('只对 task 有意义，非 task 恒 false', () => {
        expect(isClosed(room('a', 'task', { status: 'closed' }))).toBe(true);
        expect(isClosed(room('b', 'task', { status: 'open' }))).toBe(false);
        expect(isClosed(room('c', 'project', { status: 'closed' }))).toBe(false);
    });
});
