// reduce.test.ts —— 事件归约：running / speaking 的唯一真相是服务端的 running 事件。

import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState } from '../src/reduce';
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
