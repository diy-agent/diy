// shared.test.ts —— 页内共享状态（`PageApi.shared` 的实现）。
//
// 它是 view 之间唯一的通信通道，所以语义要在纯模型层就钉死：不看 React、不看 DOM，
// 只要能「写、读、按 key 订阅」三件事。

import { describe, expect, it } from 'vitest';
import { createSharedState } from '../src/shared.js';

describe('createSharedState', () => {
    it('没写过的 key 返回 undefined（initial 的活儿归 useShared，不归它）', () => {
        const shared = createSharedState();
        expect(shared.get('selectedTask')).toBeUndefined();
        shared.set('selectedTask', 't-1');
        expect(shared.get('selectedTask')).toBe('t-1');
    });

    it('只通知同一个 key 的订阅者（不同 key 互不打扰）', () => {
        const shared = createSharedState();
        const selected: unknown[] = [];
        const filter: unknown[] = [];
        shared.subscribe('selectedTask', () => selected.push(shared.get('selectedTask')));
        shared.subscribe('filter', () => filter.push(shared.get('filter')));

        shared.set('selectedTask', 't-2');
        expect(selected).toEqual(['t-2']);
        expect(filter).toEqual([]);

        shared.set('filter', 'open');
        expect(selected).toEqual(['t-2']);
        expect(filter).toEqual(['open']);
    });

    it('值没变（Object.is）就不通知：view 里算完再写回去不该引发一轮渲染', () => {
        const shared = createSharedState();
        let calls = 0;
        shared.set('selectedTask', 't-1');
        shared.subscribe('selectedTask', () => {
            calls += 1;
        });

        shared.set('selectedTask', 't-1');
        expect(calls).toBe(0);
        shared.set('selectedTask', 't-2');
        expect(calls).toBe(1);

        // NaN 这种特殊值也要按 Object.is 处理（=== 会误判成「变了」）
        shared.set('n', Number.NaN);
        shared.set('n', Number.NaN);
        expect(calls).toBe(1); // 只被上一条 selectedTask 触发过一次
    });

    it('存进去的 falsy 值（0 / "" / false）原样读得回来', () => {
        const shared = createSharedState();
        shared.set('zero', 0);
        shared.set('empty', '');
        shared.set('no', false);
        expect(shared.get('zero')).toBe(0);
        expect(shared.get('empty')).toBe('');
        expect(shared.get('no')).toBe(false);
    });

    it('退订：同一个退订函数调两次不出错，退完就不再收到通知', () => {
        const shared = createSharedState();
        let calls = 0;
        const off = shared.subscribe('selectedTask', () => {
            calls += 1;
        });
        shared.set('selectedTask', 't-1');
        expect(calls).toBe(1);

        off();
        off(); // 幂等（React 的 cleanup 可能重入）
        shared.set('selectedTask', 't-2');
        expect(calls).toBe(1);
    });

    it('监听器里退订别人不影响这一轮投递（先复制再遍历）', () => {
        const shared = createSharedState();
        const seen: string[] = [];
        const offSecond = shared.subscribe('selectedTask', () => seen.push('second'));
        shared.subscribe('selectedTask', () => {
            seen.push('first');
            offSecond();
        });

        shared.set('selectedTask', 't-1');
        expect(seen).toEqual(['second', 'first']); // 订阅顺序投递，退订从下一次起生效

        shared.set('selectedTask', 't-2');
        expect(seen).toEqual(['second', 'first', 'first']);
    });
});
