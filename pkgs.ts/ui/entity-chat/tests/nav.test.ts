// nav 插槽的注册表语义 —— 壳按它铺侧栏，所以「谁在前、重名怎么办、热更新会不会重复」
// 必须是确定的，而不是「看起来能用」。

import { describe, expect, it, beforeEach } from 'vitest';

import { navSources, registerNavSource, unregisterNavSource, type NavSource } from '../src/nav';

function source(id: string, order?: number): NavSource {
    return { id, order, render: () => null };
}

const ids = (): string[] => navSources().map((item) => item.id);

beforeEach(() => {
    for (const item of navSources()) unregisterNavSource(item.id);
});

describe('注册表', () => {
    it('按 order 排：小的在前，没写的排后面', () => {
        registerNavSource(source('c', 30));
        registerNavSource(source('none'));
        registerNavSource(source('a', 10));
        expect(ids()).toEqual(['a', 'c', 'none']);
    });

    it('同一个 order 保持注册顺序（stable sort）', () => {
        registerNavSource(source('first', 10));
        registerNavSource(source('second', 10));
        expect(ids()).toEqual(['first', 'second']);
    });

    it('重复注册同一个 id 是覆盖，不是两条', () => {
        registerNavSource(source('core:projects', 10));
        registerNavSource({ ...source('core:projects', 10), order: 99 });
        expect(ids()).toEqual(['core:projects']);
        expect(navSources()[0]?.order).toBe(99);
    });

    it('反注册没注册过的 id 不报错', () => {
        expect(() => unregisterNavSource('nope')).not.toThrow();
    });

    it('空 id 直接拒绝 —— 它是去重键，空值会让「覆盖」变成随机', () => {
        expect(() => registerNavSource(source(''))).toThrow();
    });

    it('快照引用只在变更时变（useSyncExternalStore 靠这个避免无限重渲染）', () => {
        registerNavSource(source('a', 10));
        const before = navSources();
        expect(navSources()).toBe(before);
        registerNavSource(source('b', 20));
        expect(navSources()).not.toBe(before);
    });
});
