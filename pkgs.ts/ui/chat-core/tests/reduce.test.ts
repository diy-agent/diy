// reduce.test.ts —— 事件归约：running / speaking 的唯一真相是服务端的 running 事件。

import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState, fromSnapshot } from '../src/reduce';
import type { Item } from '../src/types';

const item = (overrides: Partial<Item> = {}): Item =>
    ({
        id: 'i1',
        seq: 1,
        turnId: 't1',
        at: 0,
        status: 'done',
        author: { id: 'b1', name: 'diy', color: '#111', role: 'bot' },
        type: 'chat',
        data: { text: 'hi' },
        ...overrides,
    }) as Item;

describe('running', () => {
    it('item 到达不会把 running 清掉（A 收尾时 B 还在说）', () => {
        let state = applyEvent(emptyState(), { kind: 'running', botIds: ['b1', 'b2'] });
        state = applyEvent(state, { kind: 'item', item: item() });
        expect(state.running).toBe(true);
        expect(state.speaking).toEqual(['b1', 'b2']);
    });

    it('running 事件是唯一出口：空列表 = 全部停下', () => {
        let state = applyEvent(emptyState(), { kind: 'running', botIds: ['b1'] });
        state = applyEvent(state, { kind: 'running', botIds: [] });
        expect(state.running).toBe(false);
        expect(state.speaking).toEqual([]);
    });
});

describe('提问的结局', () => {
    const request = { askId: 'ask-1', question: '用哪个方案？', kind: 'choice' as const, at: 0 };

    it('回答后卡片不丢：搬进 answered 并带上答案', () => {
        let state = applyEvent(emptyState(), { kind: 'ask', request });
        state = applyEvent(state, { kind: 'ask.answered', askId: 'ask-1', answer: { values: ['b'] } });

        expect(state.asks).toEqual([]);
        expect(state.answered).toHaveLength(1);
        expect(state.answered[0]?.request).toEqual(request);
        expect(state.answered[0]?.answer).toEqual({ values: ['b'] });
    });

    it('取消也留痕（卡片显示"已失效"），reason 一并带上', () => {
        let state = applyEvent(emptyState(), { kind: 'ask', request });
        state = applyEvent(state, { kind: 'ask.answered', askId: 'ask-1', cancelled: true, reason: '提问已失效' });

        expect(state.answered[0]?.cancelled).toBe(true);
        expect(state.answered[0]?.reason).toBe('提问已失效');
    });

    it('未知 askId（刷新前就答完了）不会造出半张卡片', () => {
        const state = applyEvent(emptyState(), { kind: 'ask.answered', askId: 'gone', answer: { text: 'x' } });
        expect(state.answered).toEqual([]);
    });
});

describe('快照里的 running（服务端事实）', () => {
    it('卡在等上游的一轮（没有任何流式条目）也要显示在跑', () => {
        const state = fromSnapshot({ items: [item()], deliveries: [], speaking: ['b1'] });
        expect(state.running).toBe(true);
        expect(state.speaking).toEqual(['b1']);
    });

    it('服务端说没人跑就是没人跑（空数组不被倒推覆盖）', () => {
        // 老逻辑会从这条 streaming 条目倒推出 b1，于是停止按钮挂着一个早已结束的轮次
        const state = fromSnapshot({
            items: [item({ status: 'streaming' })],
            deliveries: [],
            speaking: [],
        });
        expect(state.running).toBe(false);
        expect(state.speaking).toEqual([]);
    });

    it('老服务端不带 speaking 时退回倒推', () => {
        const state = fromSnapshot({ items: [item({ status: 'streaming' })], deliveries: [] });
        expect(state.speaking).toEqual(['b1']);
    });
});

describe('compact（手动压缩的进度）', () => {
    const progress = (compactId: string, state: 'running' | 'done' | 'failed' | 'cancelled', startedAt = 0) => ({
        kind: 'compact' as const,
        compact: {
            compactId,
            botId: 'b1',
            state,
            startedAt,
            budget: { keepTurns: 10, maxChars: 1000 },
            before: { entries: 20, chars: 900 },
        },
    });

    it('同 id 的终态覆盖 running 那条，不会变成两条记录', () => {
        let state = applyEvent(emptyState(), progress('c1', 'running'));
        state = applyEvent(state, progress('c1', 'done'));
        expect(Object.keys(state.compactions)).toEqual(['c1']);
        expect(state.compactions['c1']?.state).toBe('done');
    });

    it('超过上限只留最近的几条（running 的必然在最新里）', () => {
        let state = emptyState();
        for (let i = 0; i < 12; i++) state = applyEvent(state, progress(`c${String(i)}`, 'done', i));
        expect(Object.keys(state.compactions)).toHaveLength(8);
        expect(state.compactions['c11']).toBeDefined();
        expect(state.compactions['c0']).toBeUndefined();
    });

    it('快照不带压缩进度（刷新后已完成的那次只体现在 stats 里）', () => {
        let state = applyEvent(emptyState(), progress('c1', 'done'));
        expect(Object.keys(state.compactions)).toEqual(['c1']);
        state = fromSnapshot({ items: [], deliveries: [], speaking: [] });
        expect(state.compactions).toEqual({});
    });
});
