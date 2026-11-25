// runningIndicator.test.ts —— 「疑似卡住 · 可中止」什么时候出现？
//
// 为什么值得一条：##560 那次一轮卡了 15 分钟，界面和"正常在跑"一模一样，用户
// 既看不出也停不掉。但**不能一律按秒数报** —— `waiting` 那处的 since 是回复起点
// （含中间所有流式推进），按它报会在每次段间空隙误报。这条钉住两件事：
//   1. 180 秒是线，不到不报；
//   2. 没给 `stallable`（waiting 调用点）时，秒数再大也一律不报。

import { describe, expect, it } from 'vitest';

import { stuckHintOf } from '../src/components/RunningIndicator';

describe('stuckHintOf', () => {
    it('不到 180 秒不报（正常的慢，不是卡住）', () => {
        expect(stuckHintOf(0, true)).toBeUndefined();
        expect(stuckHintOf(179, true)).toBeUndefined();
    });

    it('满 180 秒就报，且文案就是「疑似卡住 · 可中止」', () => {
        expect(stuckHintOf(180, true)).toBe('疑似卡住 · 可中止');
        expect(stuckHintOf(900, true)).toBe('疑似卡住 · 可中止');
    });

    it('还没起表（elapsed undefined）不报', () => {
        expect(stuckHintOf(undefined, true)).toBeUndefined();
    });

    it('没给 stallable（waiting 调用点）时秒数再大也不报', () => {
        expect(stuckHintOf(900)).toBeUndefined();
        expect(stuckHintOf(900, false)).toBeUndefined();
    });
});
