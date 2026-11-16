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
    it('多 agent 同轮交错：按 order 排，只在相邻时合并（被打断就另起一段）', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '问题' } }),
            // 同一轮：owner 工具 → helper 文本 → owner 文本（按 order 交错）
            item(2, { type: 'tool', turnId: 't1', author: owner, data: { name: 'get_time', state: 'ok' } }),
            item(3, { type: 'chat', turnId: 't1', author: helper, data: { text: '小满回复' } }),
            item(4, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy 回复' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        // 中间夹了 helper 的话，owner 的第二段要另起一条 —— 否则它会显示在小满下面
        expect(entries.map((entry) => entry.key)).toEqual(['i1', 't1:bot:owner', 't1:bot:helper', 't1:bot:owner#2']);
        expect(entries[0]?.kind).toBe('user');
        expect(entries[1]?.parts).toEqual([
            { kind: 'tool', id: 'i2', name: 'get_time', args: undefined, result: undefined, state: 'ok' },
        ]);
        expect(entries[2]?.parts).toEqual([{ kind: 'text', text: '小满回复' }]);
        expect(entries[3]?.parts).toEqual([{ kind: 'text', text: 'diy 回复' }]);
        // 续段在数据上仍是独立一条（顺序才正确），但要标记出来：surface 靠它
        // 决定「不重复头像与名字」，否则一轮被打断后会像连发了三条消息。
        expect(entries[1]?.continued).toBeUndefined();
        expect(entries[3]?.continued).toBe(true);
    });

    it('顺序用 order 而不是 seq：ask 挂起后落库，卡片仍在它引发的回答之前', () => {
        // 真实会话（task-mwipls4u）的 shape：bot 先发 ask（order 20），
        // 条目要等回答完才落库（seq 30），期间用户已经插了话、通知也已写入。
        const items: Item[] = [
            item(23, { type: 'chat', turnId: 't3', author: HUMAN, order: 19, data: { text: 'ask tool问我问题' } }),
            item(24, { type: 'chat', turnId: 't3', author: HUMAN, order: 21, data: { text: '说两个字' } }),
            item(25, { type: 'notice', turnId: 't3', order: 22, data: { text: '已回答：22', kind: 'ask' } }),
            item(30, {
                type: 'tool',
                turnId: 't3',
                order: 20,
                author: owner,
                data: { name: 'ask', state: 'ok', result: '用户回答：22' },
            }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'user', 'notice']);
        expect(entries[0]?.parts).toEqual([{ kind: 'text', text: 'ask tool问我问题' }]);
        expect(entries[1]?.parts).toEqual([
            { kind: 'tool', id: 'i30', name: 'ask', args: undefined, result: '用户回答：22', state: 'ok' },
        ]);
        expect(entries[2]?.parts).toEqual([{ kind: 'text', text: '说两个字' }]);
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

    it('notice / error 各自独立成条，并且会切断 bot 消息的合并', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: 'hi' } }),
            item(2, { type: 'notice', turnId: 't1', data: { text: '@小满 被激活', kind: 'mention' } }),
            item(3, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy' } }),
            item(4, { type: 'error', turnId: 't1', data: { message: '调用失败' } }),
            item(5, { type: 'chat', turnId: 't1', author: owner, data: { text: '重试成功' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'notice', 'assistant', 'error', 'assistant']);
        expect(entries[2]?.parts).toEqual([{ kind: 'text', text: 'diy' }]);
        expect(entries[4]?.key).toBe('t1:bot:owner#2');
        expect(entries[4]?.parts).toEqual([{ kind: 'text', text: '重试成功' }]);
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

describe('提问卡片', () => {
    const items: Item[] = [
        item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '开始' } }),
        item(2, { type: 'tool', turnId: 't1', author: owner, data: { name: 'ask', state: 'ok' } }),
    ];
    const request = {
        askId: 'ask-1',
        question: '用哪个方案？',
        kind: 'choice' as const,
        options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
        ],
        toolCallId: 'call-1',
        owner: OWNER.id,
        at: 0,
    };

    it('待回答：挂在工具行下面', () => {
        const entries = buildTimeline(items, [], BOTS, { asks: [request] });
        expect(entries.at(-1)?.parts.at(-1)).toEqual({ kind: 'ask', request });
    });

    it('已回答但工具行不在窗口里：挂成独立卡片，不借用最后一条 assistant', () => {
        // toolCallId 对不上任何工具行（真实场景：那条工具行已经滑出历史窗口）→
        // 不能借用「最后一条 assistant」，否则卡片跑到时间线底部、看不出属于哪一轮
        const entries = buildTimeline(items, [], BOTS, {
            answered: [{ request, answer: { values: ['b'] }, at: 1_700_000_000_100 }],
        });
        const card = entries.at(-1);
        expect(card?.key).toBe('ask:ask-1');
        expect(card?.kind).toBe('assistant');
        expect(card?.parts).toEqual([{ kind: 'ask', request, answer: { values: ['b'] } }]);
        // 原来那条工具消息没被塞进卡片
        expect(entries.at(-2)?.parts.map((part) => part.kind)).toEqual(['tool']);
    });

    it('已回答且工具行还在：挂在那个工具行下面（不多造卡片）', () => {
        const withTool: Item[] = [
            items[0]!,
            item(2, {
                id: 'tool-call-1',
                type: 'tool',
                turnId: 't1',
                author: owner,
                data: { name: 'ask', state: 'ok' },
            }),
        ];
        const entries = buildTimeline(withTool, [], BOTS, {
            answered: [{ request, answer: { values: ['b'] }, at: 1_700_000_000_100 }],
        });
        expect(entries).toHaveLength(2);
        expect(entries.at(-1)?.parts.at(-1)).toEqual({ kind: 'ask', request, answer: { values: ['b'] } });
    });

    it('已失效：带上 cancelled + 原因（同样独立成卡）', () => {
        const entries = buildTimeline(items, [], BOTS, {
            answered: [{ request, cancelled: true, reason: '提问已失效', at: 1_700_000_000_100 }],
        });
        expect(entries.at(-1)?.key).toBe('ask:ask-1');
        expect(entries.at(-1)?.parts.at(-1)).toEqual({
            kind: 'ask',
            request,
            cancelled: true,
            reason: '提问已失效',
        });
    });

    it('独立卡片不会被「谁在说话」误挂成执行中（窗口为空时 turnId 同为哨兵）', () => {
        // items 为空 ⇒ 当前轮 turnId 也是 ''，而独立卡片的 turnId 正是 '' 这个哨兵。
        // 两者一撞，那张早就有结局的老提问就会被当成这一轮的消息挂上「执行中」——
        // 用户会以为一个早已答完的问题还在跑。
        const entries = buildTimeline([], [], BOTS, {
            answered: [{ request, answer: { values: ['b'] }, at: 1_700_000_000_100 }],
            speaking: [OWNER.id],
        });
        const card = entries.find((entry) => entry.key === 'ask:ask-1');
        expect(card?.waiting).toBeUndefined();
        // 该有的「正在输入…」却不能少：没人认领的 speaking 要自己补一条
        expect(entries.at(-1)?.kind).toBe('typing');
        expect(entries.at(-1)?.author?.id).toBe(OWNER.id);
    });
});
