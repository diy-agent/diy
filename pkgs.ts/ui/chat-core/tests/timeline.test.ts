// timeline.test.ts —— 时间线分组的语义契约。
//
// 两个 surface（assistant-ui / Astryx）都只读这里的输出，所以这一层就是 parity 的锚点：
// 只要这份 fixture 的分组正确，两个表面看到的消息边界、作者、工具归属就一定一致。

import { describe, expect, it } from 'vitest';

import { buildTimeline } from '../src/timeline';
import type { Bot, Delivery, Item } from '../src/types';

const OWNER: Bot = { id: 'bot:owner', name: 'diy', color: '#111', persona: '', homeRoomId: 'proj:x', modelKey: 'm' };
const HELPER: Bot = { id: 'bot:helper', name: '小满', color: '#222', persona: '', homeRoomId: 'proj:x', modelKey: 'm' };
const BOTS = { [OWNER.id]: OWNER, [HELPER.id]: HELPER };

const HUMAN = { id: 'human:me', name: '我', color: '#999', role: 'human' as const };
const owner = { id: OWNER.id, name: OWNER.name, color: OWNER.color, role: 'bot' as const };
const helper = { id: HELPER.id, name: HELPER.name, color: HELPER.color, role: 'bot' as const };

function item(seq: number, patch: Partial<Item> & Pick<Item, 'type' | 'turnId' | 'data'>): Item {
    return {
        id: `i${seq}`,
        seq,
        order: seq,
        turn: 1,
        turnId: patch.turnId,
        at: 1_700_000_000_000 + seq,
        status: 'done',
        ...patch,
    } as Item;
}

describe('buildTimeline', () => {
    it('多 agent 同轮交错时按 (turnId, author) 聚合，不切块', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '问题' } }),
            // 同一轮：owner 工具 → helper 文本 → owner 文本（按 order 交错）
            item(2, { type: 'tool', turnId: 't1', author: owner, data: { name: 'get_time', state: 'ok' } }),
            item(3, { type: 'chat', turnId: 't1', author: helper, data: { text: '小满回复' } }),
            item(4, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy 回复' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        expect(entries.map((entry) => entry.key)).toEqual(['i1', 't1:bot:owner', 't1:bot:helper']);
        expect(entries[0]?.kind).toBe('user');
        // owner 的 key 只出现一次：工具与文本都在同一条里，且保持先后
        expect(entries[1]?.parts).toEqual([
            { kind: 'tool', id: 'i2', name: 'get_time', args: undefined, result: undefined, state: 'ok' },
            { kind: 'text', text: 'diy 回复' },
        ]);
        expect(entries[2]?.parts).toEqual([{ kind: 'text', text: '小满回复' }]);
    });

    it('把投递状态挂到用户消息上（失败也要显示）', () => {
        const deliveries: Delivery[] = [
            { entityId: 'proj:x', messageId: 'i1', botId: OWNER.id, state: 'delivered', updatedAt: 1 },
            {
                entityId: 'proj:x',
                messageId: 'i1',
                botId: HELPER.id,
                state: 'failed',
                note: 'AI_APICallError',
                updatedAt: 1,
            },
        ];
        const items: Item[] = [item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: 'hi' } })];

        const [entry] = buildTimeline(items, deliveries, BOTS);

        expect(entry?.deliveries).toEqual([
            { botId: OWNER.id, name: 'diy', color: '#111', state: 'delivered' },
            { botId: HELPER.id, name: '小满', color: '#222', state: 'failed' },
        ]);
    });

    it('notice / error 各自独立成条，且不打断后续 bot 消息', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: 'hi' } }),
            item(2, { type: 'notice', turnId: 't1', data: { text: '@小满 被激活', kind: 'mention' } }),
            item(3, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy' } }),
            item(4, { type: 'error', turnId: 't1', data: { message: '调用失败' } }),
            item(5, { type: 'chat', turnId: 't1', author: owner, data: { text: '重试成功' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'notice', 'assistant', 'error']);
        // notice 之后的同类消息仍归进同一条（同一 turn+author）
        expect(entries[2]?.parts).toEqual([
            { kind: 'text', text: 'diy' },
            { kind: 'text', text: '重试成功' },
        ]);
    });

    it('streaming 只反映在对应条目上', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: owner, data: { text: '流' }, status: 'streaming' }),
            item(2, { type: 'chat', turnId: 't1', author: helper, data: { text: '完了' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        expect(entries.map((entry) => entry.streaming)).toEqual([true, false]);
    });
});
