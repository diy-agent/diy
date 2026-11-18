// 侧栏「最后活动」那一格的写法：**压缩**形式（`刚刚` / `12m` / `3h` / `3d` / `11-17`）。
//
// 为什么单独锁：这一格现在每一行都带（项目树下所有未关闭任务 + 历史任务），
// 256px 侧栏里写「3 小时前」会把任务名挤成省略号 —— 想把它改回长写法的人先看这里。
// 绝对时刻不进这一格，只在 title 里（用 formatAtAbsolute）。

import { describe, expect, it } from 'vitest';

import { formatActivityAgo, formatAtAbsolute } from '../src/model';

/** 固定时钟：测试不能依赖真实 now（跨秒会 flaky） */
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatActivityAgo —— 压缩的相对时间', () => {
    it('没有活动（0 条消息）就是 undefined，交给界面显示「—」', () => {
        expect(formatActivityAgo(undefined, NOW)).toBeUndefined();
    });

    it('一分钟以内 / 将来时间（时钟回拨）都说「刚刚」', () => {
        expect(formatActivityAgo(NOW - 1_000, NOW)).toBe('刚刚');
        expect(formatActivityAgo(NOW + 5 * MIN, NOW)).toBe('刚刚');
    });

    it('分钟 / 小时 / 天各自降级', () => {
        expect(formatActivityAgo(NOW - 12 * MIN, NOW)).toBe('12m');
        expect(formatActivityAgo(NOW - 59 * MIN, NOW)).toBe('59m');
        expect(formatActivityAgo(NOW - 3 * HOUR, NOW)).toBe('3h');
        expect(formatActivityAgo(NOW - 23 * HOUR, NOW)).toBe('23h');
        expect(formatActivityAgo(NOW - 3 * DAY, NOW)).toBe('3d');
        expect(formatActivityAgo(NOW - 6 * DAY, NOW)).toBe('6d');
    });

    it('一周以上给日期；跨年才带年份', () => {
        expect(formatActivityAgo(new Date(2026, 10, 5, 9, 0, 0).getTime(), NOW)).toBe('11-05');
        expect(formatActivityAgo(new Date(2025, 11, 31, 23, 0, 0).getTime(), NOW)).toBe('2025-12-31');
    });
});

describe('formatAtAbsolute —— 悬停用的绝对时刻', () => {
    it('本地时区到分钟，个位数补零', () => {
        expect(formatAtAbsolute(new Date(2026, 0, 5, 9, 7, 0).getTime())).toBe('2026-01-05 09:07');
        expect(formatAtAbsolute(undefined)).toBeUndefined();
    });
});
