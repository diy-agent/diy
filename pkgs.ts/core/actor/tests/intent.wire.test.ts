// intent.wire.test.ts — 帧口径的**意图**测试：这些东西坏了，协议就悄悄变形了。
//
// 重点防两类回归：
//   1. 有人把 `partial` 加回 `type` 枚举（docs/05-multi-target.md C4 已否决）；
//   2. 有人在 `data` 外面加字段（那等于 runtime 开始替业务说话）。

import { describe, expect, it } from 'vitest';

import {
    COMMAND_FINISHED,
    COMMAND_STATUS,
    CURSOR_ZERO,
    EVENTS,
    FrameSchema,
    RESERVED_NAMES,
    compareCursor,
    decodeFrame,
    encodeFrame,
    newCommandId,
    newRequestId,
} from '../src/index.js';

describe('帧是两层结构', () => {
    it('往返编解码，data 原样不动（runtime 不解释业务）', () => {
        const frame = {
            type: 'query' as const,
            id: newRequestId(),
            name: 'roster',
            data: { nested: { deep: [1, 2, 3] } },
        };
        const decoded = decodeFrame(encodeFrame(frame));
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.frame).toEqual(frame);
    });

    it('未知 type 直接拒绝：帧种类是封闭集合', () => {
        const decoded = decodeFrame({ type: 'partial', id: 'x', data: [], failures: [] });
        expect(decoded.ok).toBe(false);
    });

    it('**`partial` 不在帧种类里**：多目标的部分失败只能是 ok + 逐项状态', () => {
        // 这条断言是刻意的：docs/05-multi-target.md C4 记录了这个否决，
        // 以后谁想加回来，先红这条测试，再去读那篇的理由。
        const types = FrameSchema.options.map((option) => option.shape.type.value);
        expect(types).toEqual(['cmd', 'query', 'accepted', 'done', 'rejected', 'ok', 'err', 'event']);
        expect(types).not.toContain('partial');
    });

    it('外层字段是白的：data 之外多一个字段也照样收（业务数据不进 runtime 的校验）', () => {
        const decoded = decodeFrame({ type: 'query', id: 'req_1', name: 'get', data: { anything: true } });
        expect(decoded.ok).toBe(true);
    });

    it('缺 id 的请求帧不成立（没法回执）', () => {
        expect(decodeFrame({ type: 'cmd', commandId: 'c1', name: 'add', data: {} }).ok).toBe(false);
    });
});

describe('三个关联标识语义不同', () => {
    it('每次尝试换新 requestId，commandId 由调用方持有（重试复用）', () => {
        expect(newRequestId()).not.toBe(newRequestId());
        const commandId = newCommandId();
        expect(commandId).toBe(commandId);
        expect(newCommandId()).not.toBe(commandId);
    });

    it('游标可比较：`after` 才可能正确', () => {
        expect(compareCursor(CURSOR_ZERO, 'e1' as never)).toBeLessThan(0);
        expect(compareCursor('e7' as never, 'e7' as never)).toBe(0);
        expect(compareCursor('e12' as never, 'e9' as never)).toBeGreaterThan(0);
    });
});

describe('`$` 前缀是 runtime 保留', () => {
    it('内置名都在 RESERVED_NAMES 里（defineKind 会拒绝业务占用）', () => {
        for (const name of [COMMAND_FINISHED, COMMAND_STATUS, EVENTS]) {
            expect(RESERVED_NAMES).toContain(name);
            expect(name.startsWith('$')).toBe(true);
        }
    });
});
