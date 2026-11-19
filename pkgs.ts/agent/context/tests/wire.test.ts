import { describe, expect, it } from 'vitest';

import { assertWireContinuity, systemHash, volatileHits, type WireStep } from '../src/testing/wire';

const step = (system: string, messages: readonly unknown[]): WireStep => ({ system, messages });
const sys = { role: 'system', content: 'SYSTEM' };
const user = (text: string) => ({ role: 'user', content: text });

describe('assertWireContinuity：只允许尾部追加', () => {
    it('system 逐字不变 + 尾部追加一条 ⇒ 通过', () => {
        expect(() => assertWireContinuity(step('S', [sys]), step('S', [sys, user('U')]))).not.toThrow();
    });

    it('system 变了 ⇒ 失败（缓存整段失效）', () => {
        expect(() => assertWireContinuity(step('S', [sys]), step('S2', [sys]))).toThrow(/system 在段内变了/);
    });

    it('历史消息变了 ⇒ 失败（只允许追加）', () => {
        expect(() =>
            assertWireContinuity(step('S', [sys, user('A')]), step('S', [{ role: 'system', content: 'S2' }])),
        ).toThrow(/messages 变短了|第 1 条历史消息变了/);
    });

    it('一步追加多条 ⇒ 失败（增量应合成一条 user 信封）', () => {
        expect(() => assertWireContinuity(step('S', [sys]), step('S', [sys, user('a'), user('b')]))).toThrow(
            /追加了 2 条/,
        );
    });

    it('工具循环可显式放宽 maxAdded', () => {
        expect(() =>
            assertWireContinuity(step('S', [sys]), step('S', [sys, user('a'), user('b')]), { maxAdded: 2 }),
        ).not.toThrow();
    });
});

describe('volatileHits：system 里不该出现易变值', () => {
    it('时间戳 / 用量 / 花费命中；纯静态文本不命中', () => {
        expect(volatileHits('ok:\n  line: 2026-11-19T10:00:00')).toContain('ISO 时间戳');
        expect(volatileHits('vars:\n  usage: 10')).toContain('用量字段');
        expect(volatileHits('vars:\n  cost: 0.1')).toContain('花费字段');
        expect(volatileHits('帮助：这是一个稳定的说明')).toEqual([]);
    });

    it('systemHash 对同一串稳定', () => {
        expect(systemHash(step('S', []))).toBe(systemHash(step('S', [])));
    });
});
