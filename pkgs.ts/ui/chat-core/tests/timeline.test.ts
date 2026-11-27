// timeline.test.ts —— 时间线分组的语义契约。
//
// 两个 surface（assistant-ui / Astryx）都只读这里的输出，所以这一层就是 parity 的锚点：
// 只要这份 fixture 的分组正确，两个表面看到的消息边界、作者、工具归属就一定一致。
//
// 分组契约只有一条：**一个 bot 在同一轮里只有一条 assistant 条目**。位置 = 它在这一轮
// 的第一个条目出现的位置，之后只往里追加。所以“被别人的话／通知插开”根本不会产生第二段 ——
// 下面的用例就是钉这一点，包括条目**乱序到达**（并发 bot 的真实情形）。

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
    it('多 agent 同轮交错：一个 bot 一条，位置按首次出现，工具与文本留在同一条里', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '问题' } }),
            // 同一轮：owner 工具 → helper 文本 → owner 文本（按 order 交错）
            item(2, { type: 'tool', turnId: 't1', author: owner, data: { name: 'get_time', state: 'ok' } }),
            item(3, { type: 'chat', turnId: 't1', author: helper, data: { text: '小满回复' } }),
            item(4, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy 回复' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        // owner 的文本被小满的话隔开，但它仍属于同一条回复 —— 不再有第二段、没有 #2 键。
        // 位置在 owner 的第一个条目（工具行）出现的地方：位置稳定优先于时间精确。
        expect(entries.map((entry) => entry.key)).toEqual(['i1', 't1:bot:owner', 't1:bot:helper']);
        expect(entries[0]?.kind).toBe('user');
        expect(entries[1]?.parts).toEqual([
            { kind: 'tool', id: 'i2', name: 'get_time', args: undefined, result: undefined, state: 'ok' },
            { kind: 'text', text: 'diy 回复' },
        ]);
        expect(entries[2]?.parts).toEqual([{ kind: 'text', text: '小满回复' }]);
    });

    it('条目乱序到达（并发 bot 交替吐字）：分组不依赖到达顺序', () => {
        // 两个 bot 同时流式：真实到达顺序会是 o1 h1 o2 h2 o3 ……
        // 但即便整批重排（order 决定位置），结果也必须一模一样 —— 一条回复不会因为
        // 中途插进别人的字而裂成两半（这就是“交错截断”没有发生空间的意思）。
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '开始' } }),
            item(2, { type: 'chat', turnId: 't1', author: owner, data: { text: 'A' } }),
            item(3, { type: 'chat', turnId: 't1', author: helper, data: { text: 'B' } }),
            item(4, { type: 'chat', turnId: 't1', author: owner, data: { text: 'A2' } }),
            item(5, { type: 'chat', turnId: 't1', author: helper, data: { text: 'B2' } }),
        ];

        const forward = buildTimeline(items, [], BOTS);
        const reversed = buildTimeline([...items].reverse(), [], BOTS);

        const shape = (entries: ReturnType<typeof buildTimeline>): unknown =>
            entries.map((entry) => [
                entry.key,
                entry.parts.map((part) => (part.kind === 'text' ? part.text : part.kind)),
            ]);
        expect(shape(forward)).toEqual([
            ['i1', ['开始']],
            ['t1:bot:owner', ['A', 'A2']],
            ['t1:bot:helper', ['B', 'B2']],
        ]);
        // 到达顺序换一遍，结果一样 —— 位置只看 order
        expect(shape(reversed)).toEqual(shape(forward));
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

        // 2026-11-27 起：同一轮里人连发两条时，回复统一落在**两条之后**
        // （原先落在中间，看起来像 bot 抢在第二条之前回话）。这里真正要钉的是
        // 「tool 条目虽然 seq=30 才落库，位置仍由 order=20 决定」—— 它紧跟着这条回复，
        // 并且排在 notice 之前，与 seq 无关。
        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'user', 'assistant', 'notice']);
        expect(entries[0]?.parts).toEqual([{ kind: 'text', text: 'ask tool问我问题' }]);
        expect(entries[1]?.parts).toEqual([{ kind: 'text', text: '说两个字' }]);
        expect(entries[2]?.parts).toEqual([
            { kind: 'tool', id: 'i30', name: 'ask', args: undefined, result: '用户回答：22', state: 'ok' },
        ]);
    });

    it('把投递状态挂到用户消息上（失败也要显示）', () => {
        const deliveries: Delivery[] = [
            { entityId: 'proj:x', messageId: 'i1', botId: OWNER.id, state: 'done', updatedAt: 1 },
            {
                entityId: 'proj:x',
                messageId: 'i1',
                botId: HELPER.id,
                state: 'done',
                note: 'failed',
                updatedAt: 1,
            },
        ];
        const items: Item[] = [item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: 'hi' } })];

        const [entry] = buildTimeline(items, deliveries, BOTS);

        expect(entry?.deliveries).toEqual([
            { botId: OWNER.id, name: 'diy', color: '#111', state: 'done' },
            { botId: HELPER.id, name: '小满', color: '#222', state: 'done', note: 'failed' },
        ]);
    });

    it('bot 自己的失败是回复的一部分：就地显示，不把后面的字顶到前面', () => {
        // `run.failed` 的错误条目带 author。失败之后同一个 bot 在同一轮里还可能再跑一次
        // （排队中的投递带着同一个 turnId）—— 这时「失败」夹在两段话中间。
        // 如果它单独成条，位置只能是整条回复之后，读起来就是「先成功、后失败」，因果倒挂。
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: 'hi' } }),
            item(2, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy' } }),
            item(3, { type: 'error', turnId: 't1', author: owner, data: { message: '调用失败' } }),
            item(4, { type: 'chat', turnId: 't1', author: owner, data: { text: '重试成功' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
        expect(entries[1]?.parts).toEqual([
            { kind: 'text', text: 'diy' },
            { kind: 'error', message: '调用失败' },
            { kind: 'text', text: '重试成功' },
        ]);
    });

    it('轮级结局（没有 author 的 error / notice）单独成条', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: 'hi' } }),
            item(2, { type: 'notice', turnId: 't1', data: { text: '@小满 被激活', kind: 'mention' } }),
            item(3, { type: 'chat', turnId: 't1', author: owner, data: { text: 'diy' } }),
            item(4, { type: 'error', turnId: 't1', data: { message: '调用失败' } }),
            item(5, { type: 'chat', turnId: 't1', author: owner, data: { text: '重试成功' } }),
        ];

        const entries = buildTimeline(items, [], BOTS);

        // `endItems()` 产的结局条目没有 author：它说的是「这一轮怎么停的」，属于轮不属于回复。
        // 它本来就是这一轮的最后一句，所以排在回复之后是对的。
        // （带 author 的错误走 part，见上一条用例。）
        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'notice', 'assistant', 'error']);
        expect(entries[2]?.key).toBe('t1:bot:owner');
        expect(entries[2]?.parts).toEqual([
            { kind: 'text', text: 'diy' },
            { kind: 'text', text: '重试成功' },
        ]);
        expect(entries[3]?.parts).toEqual([{ kind: 'text', text: '调用失败' }]);
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

    it('工具行滑出窗口、但那轮还在：按 turnId 挂回那条回复（不再是独立卡片）', () => {
        // turnId 是提问时盖上去的（`AskRequest.turnId`）：那一轮只要还有条目在窗口里，
        // 卡片就能回到它该在的位置 —— 不需要搜那个已经不在的工具行，也不需要另造一张条。
        const withTurn = { ...request, turnId: 't1' };
        const entries = buildTimeline(items, [], BOTS, {
            answered: [{ request: withTurn, answer: { values: ['b'] }, at: 1_700_000_000_100 }],
        });

        expect(entries.map((entry) => entry.key)).toEqual(['i1', 't1:bot:owner']);
        expect(entries[1]?.parts.at(-1)).toEqual({ kind: 'ask', request: withTurn, answer: { values: ['b'] } });
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

    it('带 turnId 的独立卡片不参与「执行中」的匹配（只认当前轮）', () => {
        // 它是**旧轮**的卡片：当前轮是 t9，不能把它当成这一轮还没说完的话
        const old = { ...request, turnId: 't-old' };
        const entries = buildTimeline([], [], BOTS, {
            answered: [{ request: old, answer: { values: ['b'] }, at: 1 }],
            speaking: [OWNER.id],
        });
        const card = entries.find((entry) => entry.key === 'ask:ask-1');
        expect(card?.turnId).toBe('t-old');
        expect(card?.waiting).toBeUndefined();
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

describe('buildTimeline：附件', () => {
    it('人发的消息带附件 ⇒ user 条目原样带出来（界面靠它画图）', () => {
        const shot = {
            type: 'stored' as const,
            id: '2026-11-26/093012-abcd1234/01-shot.png',
            relPath: '2026-11-26/093012-abcd1234/01-shot.png',
            kind: 'image' as const,
            mime: 'image/png',
            bytes: 2048,
            displayName: 'shot.png',
            source: 'paste' as const,
            createdAt: 1_700_000_000_000,
            sha256: 'a'.repeat(64),
        };
        const entries = buildTimeline(
            [item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '看这张', attachments: [shot] } })],
            [],
            BOTS,
        );
        expect(entries[0]?.kind).toBe('user');
        expect(entries[0]?.attachments).toEqual([shot]);
    });

    it('没有附件的消息不带这个字段（老数据形状不变）', () => {
        const entries = buildTimeline(
            [item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '一句' } })],
            [],
            BOTS,
        );
        expect(entries[0]).not.toHaveProperty('attachments');
    });
});

describe('buildTimeline：同一轮里人连发两条', () => {
    it('bot 的整段回复排在两条之前，不插在中间（用户 2026-11-27 实测报的「回复在我的图上方」）', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '先发一段文字' } }),
            // bot 的第一个条目在第二条人的消息**之前**就落库了（它在跑，人又补了一条）
            item(2, { type: 'chat', turnId: 't1', author: owner, data: { text: '我先看看' } }),
            item(3, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '补一张图' } }),
            item(4, { type: 'chat', turnId: 't1', author: owner, data: { text: '图我看到了' } }),
        ];
        const entries = buildTimeline(items, [], BOTS);

        // 视觉顺序：人的两条 → bot 的整段回复（回复仍然只有一条，不切段）
        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'user', 'assistant']);
        const reply = entries.at(-1);
        expect(reply?.parts.map((part) => (part.kind === 'text' ? part.text : ''))).toEqual(['我先看看', '图我看到了']);
    });

    it('只有一条人的消息时顺序不变（不因为这条改动而动老行为）', () => {
        const items: Item[] = [
            item(1, { type: 'chat', turnId: 't1', author: HUMAN, data: { text: '问一句' } }),
            item(2, { type: 'chat', turnId: 't1', author: owner, data: { text: '答一句' } }),
        ];
        const entries = buildTimeline(items, [], BOTS);
        expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
    });
});
