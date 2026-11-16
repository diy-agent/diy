// room-scenarios.ts —— **房间级**的「停」样本：一轮一停之外的麻烦。
//
// `stop-scenarios.ts` 回答「这一轮为什么停」；这里回答「停法多了以后，时间线会不会串」：
//   · 两只 bot 各停一种 → 页脚会不会挂到别人头上
//   · 同一轮被工具切成多段 → 页脚会不会挂两遍 / 挂到半句话下面
//   · 连续两轮一坏一好 → 前一轮的结局会不会粘到后一轮
//   · 房间广播丢了 → 前端到底还知道什么（`turn.end` 是一次连接里的事实）
//   · 一只 bot 一个字没说就失败 → 结局只能挂在 notice/error 条目上，挂得住吗
//
// 这些**手测几乎复现不了**（要两只 bot 同时跑到不同结局、还要卡在同一个水位上），
// 所以装配成事件流：真 `Projector` + 真判据（`end-reason.ts`），页面上显示的就是
// 这套代码对这些流的实际处理结果。比单轮样本多的一件事：**全局 seq 重排** ——
// 多轮的事件各自从 1 开始 seq，混进一条房间时间线时必须严格递增，否则排序靠 id 兜底，
// 看上去"能用"，真出事时才发现在比字符串。

import { endItems, endReasonOf, adviceOf, publishable, type EndFacts } from './end-reason';
import { Projector } from './projection';
import { factsOf, ItemLedger, type StopTurn } from './stop-scenarios';
import type { AgentEvent, Author, Item, TurnEndReason } from './types';

const BUDGET = 8192;

const AUTHOR_A: Author = { id: 'bot-astryx', name: 'astryx', color: '#7c9cff', role: 'bot' };
const AUTHOR_B: Author = { id: 'bot-diy', name: 'diy', color: '#f0b46a', role: 'bot' };

/** 房间时间线里的一轮：谁说的、哪轮、那条事件流、结局有没有广播出去 */
export interface RoomTurn extends StopTurn {
    bot: Author;
    turnId: string;
    /**
     * 房间有没有把这一轮的 `turn.end` 广播给前端（缺省 true）。
     * 断流 / 重连丢事件时为 false：**前端不知道结局**，但时间线上的 notice/error 条目还在。
     */
    broadcast?: boolean;
}

/** 页脚该挂在哪：挂在最后一段 bot 消息上 / 挂在 notice·error 条目上 / 不该有页脚 */
export type FooterExpectation = 'last-segment' | 'notice' | 'none';

export interface RoomScenario {
    id: string;
    title: string;
    trigger: string;
    turns: RoomTurn[];
    /** 每一轮**必须**被判成什么（测试按它锁判据；lab 页拿它做自检） */
    expect: Array<{ turnId: string; reason: TurnEndReason['type']; note?: string }>;
    /** 页脚**必须**挂在哪（lab 页拿它做自检：挂错位置就和挂错内容一样糟） */
    expectFooters: Array<{ turnId: string; on: FooterExpectation }>;
}

export interface RoomTurnReplay {
    turn: RoomTurn;
    facts: EndFacts;
    reason: TurnEndReason;
    /** 这一轮落到时间线上的条目（含收尾补的 notice/error） */
    items: Item[];
    advice: string;
    publishable: boolean;
    /** 前端能不能知道这一轮的结局（`turn.end` 到得了吗） */
    known: boolean;
}

export interface RoomReplay {
    scenario: RoomScenario;
    turns: RoomTurnReplay[];
    /** 整间房合并后的一条时间线（seq 已全局重排、严格递增） */
    items: Item[];
    /** 前端实际拿到的 turnId → 结局（只含广播出去的那些轮） */
    endReasons: Record<string, TurnEndReason>;
    /** 修复前：没有判据、不收尾、没有 `turn.end` —— 同一条流的下场（对照用） */
    legacy: { label: string; items: Item[] };
}

/** 单轮重放：真 Projector 收事件 + 收尾，再补上判据要求的 notice/error（入账规则见 `ItemLedger`） */
function replayTurn(turn: RoomTurn, index: number, events: AgentEvent[], ledger: ItemLedger): Item[] {
    const projector = new Projector(turn.bot, index + 1);
    // `run.failed` 的原文 Projector 已经落过一条错误条目，收尾时别再补（同一句话不出现两次）
    let errorReported = false;
    for (const event of events) {
        for (const item of projector.apply(event)) {
            if (item.type === 'error') errorReported = true;
            ledger.emit(item);
        }
    }
    for (const item of projector.finalize()) ledger.emit(item);

    const facts = factsOf(turn);
    const reason = endReasonOf(facts);
    const failure = turn.events.find((event) => event.type === 'run.failed');
    for (const item of endItems(
        reason,
        {
            turn: index + 1,
            turnId: turn.turnId,
            at: 1762400000000 + index * 60_000,
            ...(failure?.type === 'run.failed' ? { failureMessage: failure.message } : {}),
        },
        { errorAlreadyReported: errorReported },
    ))
        ledger.emit(item);

    // 这一轮自己的条目（共享账本里按 id 取回）

    return ledger.live().filter((item) => item.turnId === turn.turnId);
}

export function replayRoom(scenario: RoomScenario): RoomReplay {
    // 多轮事件各自从 1 起 seq，混进一条房间时间线必须全局重排（否则排序靠 id 兜底）
    let cursor = 0;
    const ledger = new ItemLedger();
    const endReasons: Record<string, TurnEndReason> = {};
    const turns: RoomTurnReplay[] = [];

    scenario.turns.forEach((turn, index) => {
        const events = turn.events.map((event) => ({ ...event, seq: (cursor += 1) }));
        const facts = factsOf(turn);
        const reason = endReasonOf(facts);
        const known = turn.broadcast !== false;
        if (known) endReasons[turn.turnId] = reason;
        turns.push({
            turn,
            facts,
            reason,
            items: replayTurn(turn, index, events, ledger),
            advice: adviceOf(reason),
            publishable: publishable(reason),
            known,
        });
    });

    // 修复前：不 finalize、不补条目、不看 finishReason —— 只有「跑成/没跑成」
    const legacyLedger = new ItemLedger();
    let legacyCursor = 0;
    scenario.turns.forEach((turn, index) => {
        const projector = new Projector(turn.bot, index + 1);
        for (const event of turn.events) {
            for (const item of projector.apply({ ...event, seq: (legacyCursor += 1) })) legacyLedger.emit(item);
        }
    });

    return {
        scenario,
        turns,
        items: ledger.live(),
        endReasons,
        legacy: {
            label: scenario.turns.some((turn) => factsOf(turn).failed === true) ? '有失败' : '全部完成',
            items: legacyLedger.live(),
        },
    };
}

// ── 样本 ────────────────────────────────────────────────────────

const HALF = '我先读一下 room.ts。第一处要改的是判';

export const ROOM_SCENARIOS: readonly RoomScenario[] = [
    {
        id: 'two-bots-different-stops',
        title: '两只 bot 各停一种（页脚会不会串台）',
        trigger: 'astryx 正常说完，diy 同一时间被输出上限截断 —— 同一屏里两种结局',
        turns: [
            {
                bot: AUTHOR_A,
                turnId: 't-astryx',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-astryx', messageId: 'm-a' },
                    { seq: 2, type: 'text.delta', messageId: 'm-a', delta: '并发问题在 drainPending 里，已经改好。' },
                    {
                        seq: 3,
                        type: 'run.finished',
                        turnId: 't-astryx',
                        finishReason: 'stop',
                        steps: 1,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 4, type: 'message.completed', messageId: 'm-a' },
                    { seq: 5, type: 'run.completed', turnId: 't-astryx' },
                ],
            },
            {
                bot: AUTHOR_B,
                turnId: 't-diy',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-diy', messageId: 'm-b' },
                    { seq: 2, type: 'text.delta', messageId: 'm-b', delta: HALF },
                    {
                        seq: 3,
                        type: 'run.finished',
                        turnId: 't-diy',
                        finishReason: 'length',
                        steps: 1,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 4, type: 'message.completed', messageId: 'm-b' },
                    { seq: 5, type: 'run.completed', turnId: 't-diy' },
                ],
            },
        ],
        expect: [
            { turnId: 't-astryx', reason: 'completed' },
            { turnId: 't-diy', reason: 'max-tokens' },
        ],
        expectFooters: [
            { turnId: 't-astryx', on: 'none' },
            { turnId: 't-diy', on: 'last-segment' },
        ],
    },
    {
        id: 'multi-segment-tool-mismatch',
        title: '同一轮被工具切成两段（页脚只能挂一次）',
        trigger: '说一段 → 调工具 → 又说一段 → 工具结果没回来就收尾（finish=tool-calls）',
        turns: [
            {
                bot: AUTHOR_A,
                turnId: 't-seg',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-seg', messageId: 'm-s' },
                    { seq: 2, type: 'text.delta', messageId: 'm-s', delta: '我先看一眼现有的断言：' },
                    {
                        seq: 3,
                        type: 'tool.started',
                        turnId: 't-seg',
                        toolCallId: 'call-1',
                        name: 'bash',
                        args: { command: 'rg -n "endReason" tests' },
                    },
                    {
                        seq: 4,
                        type: 'tool.completed',
                        turnId: 't-seg',
                        toolCallId: 'call-1',
                        name: 'bash',
                        result: 'ok',
                    },
                    { seq: 5, type: 'text.delta', messageId: 'm-s', delta: '断言在 end-footer.test.ts 里，我准备' },
                    {
                        seq: 6,
                        type: 'run.finished',
                        turnId: 't-seg',
                        finishReason: 'tool-calls',
                        steps: 2,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 7, type: 'message.completed', messageId: 'm-s' },
                    { seq: 8, type: 'run.completed', turnId: 't-seg' },
                ],
            },
        ],
        expect: [{ turnId: 't-seg', reason: 'tool-mismatch' }],
        expectFooters: [{ turnId: 't-seg', on: 'last-segment' }],
    },
    {
        id: 'stale-then-good',
        title: '连续两轮：坏的那轮结局不许粘到下一轮',
        trigger: '第 1 轮流被掐断（unknown），第 2 轮正常说完 —— 页脚只应出现在第 1 轮',
        turns: [
            {
                bot: AUTHOR_A,
                turnId: 't-bad',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-bad', messageId: 'm-1' },
                    { seq: 2, type: 'text.delta', messageId: 'm-1', delta: HALF },
                ],
            },
            {
                bot: AUTHOR_A,
                turnId: 't-good',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-good', messageId: 'm-2' },
                    { seq: 2, type: 'text.delta', messageId: 'm-2', delta: '重试了一次，这次跑完了：判据改成两类。' },
                    {
                        seq: 3,
                        type: 'run.finished',
                        turnId: 't-good',
                        finishReason: 'stop',
                        steps: 1,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 4, type: 'message.completed', messageId: 'm-2' },
                    { seq: 5, type: 'run.completed', turnId: 't-good' },
                ],
            },
        ],
        expect: [
            { turnId: 't-bad', reason: 'unknown', note: 'no-finish' },
            { turnId: 't-good', reason: 'completed' },
        ],
        expectFooters: [
            { turnId: 't-bad', on: 'last-segment' },
            { turnId: 't-good', on: 'none' },
        ],
    },
    {
        id: 'interjection',
        title: '插话：上一轮被停，下一轮接着做',
        trigger: 'diy 正在改文件，用户插话 → 本轮 abort（interrupted），新的一轮正常跑完',
        turns: [
            {
                bot: AUTHOR_B,
                turnId: 't-cut',
                aborted: true,
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-cut', messageId: 'm-1' },
                    { seq: 2, type: 'text.delta', messageId: 'm-1', delta: '先把 ask 的超时改成' },
                    {
                        seq: 3,
                        type: 'tool.started',
                        turnId: 't-cut',
                        toolCallId: 'call-1',
                        name: 'edit',
                        args: { path: 'src/ask.ts' },
                    },
                    {
                        seq: 4,
                        type: 'run.finished',
                        turnId: 't-cut',
                        finishReason: 'aborted',
                        steps: 1,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 5, type: 'run.completed', turnId: 't-cut' },
                ],
            },
            {
                bot: AUTHOR_B,
                turnId: 't-next',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-next', messageId: 'm-2' },
                    { seq: 2, type: 'text.delta', messageId: 'm-2', delta: '按你说的改成 3 分钟，改完了。' },
                    {
                        seq: 3,
                        type: 'run.finished',
                        turnId: 't-next',
                        finishReason: 'stop',
                        steps: 1,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 4, type: 'message.completed', messageId: 'm-2' },
                    { seq: 5, type: 'run.completed', turnId: 't-next' },
                ],
            },
        ],
        expect: [
            { turnId: 't-cut', reason: 'interrupted' },
            { turnId: 't-next', reason: 'completed' },
        ],
        expectFooters: [
            { turnId: 't-cut', on: 'last-segment' },
            { turnId: 't-next', on: 'none' },
        ],
    },
    {
        id: 'both-fail-differently',
        title: '两只 bot 同时失败：一只没说一个字，一只说了一半',
        trigger: 'astryx 401 直接失败（0 字，结局只能挂在 error 条目上），diy 半句话后连接断',
        turns: [
            {
                bot: AUTHOR_A,
                turnId: 't-auth',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-auth', messageId: 'm-1' },
                    {
                        seq: 2,
                        type: 'run.failed',
                        turnId: 't-auth',
                        message: '401 Invalid API key（检查 DEEPSEEK_API_KEY）',
                    },
                ],
            },
            {
                bot: AUTHOR_B,
                turnId: 't-cut',
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-cut', messageId: 'm-2' },
                    { seq: 2, type: 'text.delta', messageId: 'm-2', delta: HALF },
                ],
            },
        ],
        expect: [
            { turnId: 't-auth', reason: 'error' },
            { turnId: 't-cut', reason: 'unknown', note: 'no-finish' },
        ],
        expectFooters: [
            { turnId: 't-auth', on: 'notice' },
            { turnId: 't-cut', on: 'last-segment' },
        ],
    },
    {
        id: 'broadcast-lost',
        title: '房间广播丢了（前端只知道条目，不知道结局）',
        trigger: 'turn.end 没送到前端（SSE 断 / 重连跳过了水位）—— notice 条目还在，页脚没了',
        turns: [
            {
                bot: AUTHOR_B,
                turnId: 't-lost',
                broadcast: false,
                events: [
                    { seq: 1, type: 'run.started', turnId: 't-lost', messageId: 'm-1' },
                    { seq: 2, type: 'text.delta', messageId: 'm-1', delta: HALF },
                    {
                        seq: 3,
                        type: 'run.finished',
                        turnId: 't-lost',
                        finishReason: 'length',
                        steps: 1,
                        maxOutputTokens: BUDGET,
                    },
                    { seq: 4, type: 'message.completed', messageId: 'm-1' },
                    { seq: 5, type: 'run.completed', turnId: 't-lost' },
                ],
            },
        ],
        expect: [{ turnId: 't-lost', reason: 'max-tokens' }],
        expectFooters: [{ turnId: 't-lost', on: 'none' }],
    },
];
