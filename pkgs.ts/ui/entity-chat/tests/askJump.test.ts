// askJump.test.ts —— 「跳到某张提问卡」的派发：谁注册谁接，没注册就按 DOM 兜底。
//
// 这条链的 bug 都是**静默**的（点了不滚、闪在隐藏表面上），所以钉住：注册 → 派发到注册者；
// 注销 → 不再派发；没有注册者 → 走兜底且不抛（兜底找不到元素也不能炸）。

import { afterEach, describe, expect, it, vi } from 'vitest';

import { jumpToAsk, registerAskJumper } from '../src/askJump';

afterEach(() => {
    vi.unstubAllGlobals();
    registerAskJumper('s1', undefined);
});

describe('askJump', () => {
    it('注册的那一份接到调用', () => {
        const calls: string[] = [];
        registerAskJumper('s1', (askId) => calls.push(askId));
        jumpToAsk('s1', 'ask-7');
        expect(calls).toEqual(['ask-7']);
    });

    it('注销之后不再派发，走兜底（找不到元素也不抛）', () => {
        const calls: string[] = [];
        registerAskJumper('s1', (askId) => calls.push(askId));
        registerAskJumper('s1', undefined);
        vi.stubGlobal('document', { querySelectorAll: () => [] });
        expect(() => jumpToAsk('s1', 'ask-7')).not.toThrow();
        expect(calls).toEqual([]);
    });

    it('没有注册者时按 DOM 兜底：找到可见卡片就闪它', () => {
        const classes = new Set<string>();
        const element = {
            classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
            getClientRects: () => [{}],
            scrollIntoView: () => undefined,
        };
        vi.stubGlobal('document', { querySelectorAll: () => [element] });
        vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });
        jumpToAsk('nobody', 'ask-9');
        expect(classes.has('ring-2')).toBe(true);
    });
});
