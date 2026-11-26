// chat.history 的 tool 结果裁剪：回包体积的唯一闸门（2026-11-26，28MB → 秒级）。
import { describe, expect, it } from 'vitest';

import { trimToolResults } from '../server/app';
import type { Item } from '@diy-agent/protocol';

const base = { id: 'x', seq: 1, turn: 1, turnId: 't1', at: 1, status: 'done' as const };

function tool(result: unknown): Item {
    return {
        ...base,
        author: { id: 'b1', name: 'b', color: '#fff', role: 'bot' },
        type: 'tool',
        data: { name: 'bash', result, state: 'ok' },
    };
}

describe('trimToolResults —— 历史回包瘦身', () => {
    it('小结果原样带（不动内容）', () => {
        const item = tool('ok');
        const [out] = trimToolResults([item]);
        expect(out).toBe(item);
    });

    it('大结果裁到 400 字，并写明原文多少字（不假装是全部）', () => {
        const big = 'x'.repeat(9_500_000);
        const [out] = trimToolResults([tool(big)]);
        const result = (out as Extract<Item, { type: 'tool' }>).data.result as string;
        expect(result.length).toBeLessThan(500);
        expect(result).toContain('原文 9500000 字');
    });

    it('非 tool 条目一个字节都不动（chat / notice / error）', () => {
        const chat: Item = {
            ...base,
            author: { id: 'b1', name: 'b', color: '#fff', role: 'bot' },
            type: 'chat',
            data: { text: 'y'.repeat(5000) },
        };
        const [out] = trimToolResults([chat]);
        expect(out).toBe(chat);
    });

    it('result 不是字符串（对象/空）不碰 —— 结构不是我们造的，不猜', () => {
        const obj = tool({ stdout: 'z'.repeat(100_000) });
        const [out] = trimToolResults([obj]);
        expect(out).toBe(obj);
    });
});
