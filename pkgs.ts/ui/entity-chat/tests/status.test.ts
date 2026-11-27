// 任务状态两态（open / closed）的判据：老数据归一、树里该不该出现、已关闭表怎么排。
//
// 这几个函数是侧栏两处的**同一份真相**（项目树只留 open 的、导航底部「历史任务」按关闭时间倒序），
// 所以在这里锁行为 —— 三态时代留下的 todo / doing / done 必须在读的时候就归位，
// 否则用户升级后会发现「以前标过的 done 又回到树里了」。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StatusGlyph } from '../src/components/RoomName';
import {
    closedAtOf,
    closedTasksOf,
    formatClosedAgo,
    formatClosedAtAbsolute,
    isClosed,
    taskStatusOf,
    toggleTaskStatus,
    visibleInTree,
} from '../src/model';
import type { Room } from '../src/model';

function room(id: string, type: string, data: Record<string, unknown> = {}): Room {
    return { id, type, name: id, data, members: [], modelKey: 'm' };
}

describe('StatusGlyph —— 任务状态图标与运行提示分开表达', () => {
    it('open/closed 是状态形状；运行时只附加呼吸点，不替换状态图标', () => {
        const open = renderToStaticMarkup(
            createElement(StatusGlyph, { room: room('open', 'task', { status: 'open' }), running: true }),
        );
        const closed = renderToStaticMarkup(
            createElement(StatusGlyph, { room: room('closed', 'task', { status: 'closed' }), running: true }),
        );

        expect(open).toContain('lucide-circle-dot');
        // 呼吸 = 扩散光晕（animate-ping）+ 一颗带背景环的点；两者都在，且不动状态图标的形状
        expect(open).toContain('animate-ping');
        expect(open).toContain('aria-label="正在运行"');
        expect(closed).toContain('lucide-circle-check');
        expect(closed).toContain('animate-ping');
        const idle = renderToStaticMarkup(
            createElement(StatusGlyph, { room: room('idle', 'task', { status: 'open' }) }),
        );
        expect(idle).not.toContain('animate-ping');
        expect(idle).not.toContain('aria-label="正在运行"');
    });
});

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

describe('formatClosedAgo —— 历史行行尾的关闭时间', () => {
    // 固定"现在"：测试不能依赖真实时钟，否则跨分钟就会偶发失败
    const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const minutesAgo = (n: number) => now - n * 60_000;

    it('不到一分钟、以及时钟回拨（将来时间），都说「刚刚」', () => {
        expect(formatClosedAgo(minutesAgo(0), now)).toBe('刚刚');
        expect(formatClosedAgo(minutesAgo(0) - 59_000, now)).toBe('刚刚');
        expect(formatClosedAgo(now + 10 * 60_000, now)).toBe('刚刚');
    });

    it('分钟 / 小时 / 天，各自只在自己那档里报数', () => {
        expect(formatClosedAgo(minutesAgo(1), now)).toBe('1 分钟前');
        expect(formatClosedAgo(minutesAgo(59), now)).toBe('59 分钟前');
        expect(formatClosedAgo(minutesAgo(60), now)).toBe('1 小时前');
        expect(formatClosedAgo(minutesAgo(23 * 60 + 59), now)).toBe('23 小时前');
        expect(formatClosedAgo(minutesAgo(24 * 60), now)).toBe('1 天前');
        expect(formatClosedAgo(minutesAgo(6 * 24 * 60 + 60), now)).toBe('6 天前');
    });

    it('超过一周给日期（同年不带年份），跨年才带', () => {
        // 用 Date 自己算「7 天前」，不手写 epoch —— 夏令时下 epoch 差不是整 7*86400000
        const old = new Date(2026, 10, 5, 9, 30).getTime();
        expect(formatClosedAgo(old, now)).toBe('11-05');
        const lastYear = new Date(2025, 11, 30, 9, 30).getTime();
        expect(formatClosedAgo(lastYear, now)).toBe('2025-12-30');
    });

    it('没有 closedAt 的老数据：不显示，而不是显示「刚刚」', () => {
        expect(formatClosedAgo(undefined, now)).toBeUndefined();
    });
});

describe('formatClosedAtAbsolute —— 悬停看的绝对时刻', () => {
    it('本地时区、补零到分钟', () => {
        expect(formatClosedAtAbsolute(new Date(2026, 0, 5, 7, 8).getTime())).toBe('2026-01-05 07:08');
        expect(formatClosedAtAbsolute(undefined)).toBeUndefined();
    });
});
