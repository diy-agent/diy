import { describe, expect, it } from 'vitest';

import { mergePendingAsks } from '../src/pendingAsk';

describe('侧栏 ? 的合并规则', () => {
    it('没在看房间：完全照服务端投影', () => {
        expect(mergePendingAsks({ a: 2 }, { a: 1 }, '')).toEqual({ a: 2 });
    });

    it('正在看且流已热：流说 0 就灭，不等 30 秒轮询', () => {
        expect(mergePendingAsks({ a: 2, b: 1 }, { a: 0 }, 'a')).toEqual({ b: 1 });
    });

    it('正在看且流已热：流先说新提问，不必等 /rooms 追上', () => {
        expect(mergePendingAsks({}, { a: 3 }, 'a')).toEqual({ a: 3 });
    });

    it('离开过的房间交回服务端：本地那份冻在离开前，不能一直亮', () => {
        // 看 a 时有 1 条 → 切到 b（a 的订阅被 dispose，本地停在 1）→ 提问在别处答掉，服务端 0
        expect(mergePendingAsks({}, { a: 1 }, 'b')).toEqual({});
        expect(mergePendingAsks({ a: 1 }, { a: 5 }, 'b')).toEqual({ a: 1 });
    });

    it('流还没热身时调用方传空串：本地空快照不吃掉服务端的数', () => {
        expect(mergePendingAsks({ a: 2 }, { a: 0 }, '')).toEqual({ a: 2 });
    });

    it('两边都是 0 时不留空键', () => {
        expect(mergePendingAsks({ a: 0 }, { a: 0 }, 'a')).toEqual({});
    });
});
