// stop-scenarios.ts —— 「这一轮是怎么停的」的脚本化样本（lab 页与测试共用）。
//
// 每条场景 = 运行时**真实会发**的那条事件流（顺序、字段都与 `agent.ts` 一致）。
// 把它喂给真 `Projector` + 真判据（`end-reason.ts`），于是：
//   · lab 页显示的**不是画出来的示意**，而是这套代码对这条流的实际处理结果；
//   · 测试能锁住「这条流必须判成这个类」—— 判据一改，样本先红。
//
// 这个文件保持纯净：不 import agent / db / room，所以浏览器里能跑（lab 页就是这么做）。
// 也因此 `end-reason.ts` 的注释里说的「lab 页共用一份判据」落在这里，而不是另写一套模拟。

import { adviceOf, endItems, endReasonOf, publishable, type EndFacts } from './end-reason';
import { Projector } from './projection';
import type { AgentEvent, Author, Item, TurnEndReason } from './types';

/** 房间里的那只 bot（时间线上要显示头像/名字，样本里固定一只） */
const BOT: Author = { id: 'bot-diy', name: 'diy', color: '#7c9cff', role: 'bot' };
/** deepseek 的输出上限（和 providers.ts 里的一致，对账时看得到"到底哪一层截的"） */
const BUDGET = 8192;
const TURN_ID = 'turn-demo';

/** 一轮的事实来源：单轮样本（`StopScenario`）与房间样本（`room-scenarios.ts` 的 `RoomTurn`）共用 */
export interface StopTurn {
    /** 运行时真实会发的事件流（`run.started` → … → 收尾） */
    events: AgentEvent[];
    /** 人按了停（来自 abort signal，不在事件流里） */
    aborted?: boolean;
    /** 本轮实际发出去的上限（缺省 BUDGET） */
    maxOutputTokens?: number;
}

export interface StopScenario extends StopTurn {
    id: string;
    /** 一句话说这是什么停法 */
    title: string;
    /** 触发条件：真实世界里它由什么引起 */
    trigger: string;
    /** 这条流**必须**被判成什么（测试按它锁判据；lab 页拿它做自检） */
    expect: TurnEndReason['type'];
    /** expect 为 `unknown` 时的细因 */
    expectNote?: string;
}

export interface StopReplay {
    scenario: StopScenario;
    facts: EndFacts;
    reason: TurnEndReason;
    /** 这一轮发生了什么（Item），`replay` 把收尾也补进去了 —— 与 session 落库的一致 */
    items: Item[];
    /** 用户该做什么（`adviceOf`） */
    advice: string;
    /** 这一轮的产出能不能当结论发到房间（`publishable`） */
    publishable: boolean;
    /** 修复前：没有判据、不收尾、不解释 —— 同一条事件流的下场（对照用） */
    legacy: { label: string; items: Item[] };
}

/** 从事件流还原 session 收集的那几个事实（同一套口径，别在页面里另算一遍） */
export function factsOf(turn: StopTurn): EndFacts {
    let failed = false;
    let finished = false;
    let finishReason: string | undefined;
    let steps = 0;
    let textLength = 0;
    let toolCalls = 0;
    /** 看门狗杀的那一轮：`run.failed.stall` 是唯一来源（与 `session.ts` 同口径） */
    let stall: { awaiting: string; idleMs: number } | undefined;

    for (const event of turn.events) {
        if (event.type === 'run.failed') {
            failed = true;
            if (event.stall !== undefined) {
                stall = {
                    awaiting: event.stall.phase === 'tool' ? 'tool' : 'model-stream',
                    idleMs: event.stall.waitedMs,
                };
            }
        }
        if (event.type === 'run.finished') {
            finished = true;
            finishReason = event.finishReason;
            steps = event.steps;
        }
        if (event.type === 'tool.started') toolCalls += 1;
        if (event.type === 'text.delta') textLength += event.delta.length;
    }

    return {
        failed,
        aborted: turn.aborted === true,
        ...(stall === undefined ? {} : { abortedBy: 'deadline' as const, stall }),
        finished,
        ...(finishReason === undefined ? {} : { finishReason }),
        steps,
        textLength,
        toolCalls,
        maxOutputTokens: turn.maxOutputTokens ?? BUDGET,
    };
}

/**
 * 条目账本：复刻 `room.ts::onSessionEvent` 的入账规则（**顺序语义全靠它**）。
 *
 *   · `order` —— 条目**出现**的时刻，首次 emit 时分配，单调递增。展示顺序用它。
 *   · `seq`   —— 条目**落库**的时刻，只有变成 `done`/`failed` 时才落、每个 id 只落一次。
 *
 * 为什么必须在样本里复刻：`endItems()` 产出的 notice 自带 `seq: 0`（真 seq 由入库自增补），
 * 不去模拟这一步，lab 页就会把「被截断」那条提示排到消息**前面**去，看上去像另一个 bug。
 * 而且一条事件流被重放两次时，`nextId` 会给两批 id，条目凭空多一条 —— 这个错只有
 * 「按真实规则入账 + 断言 id 不重复」才拦得住。
 */
export class ItemLedger {
    private orderSeq = 0;
    private storeSeq = 0;
    private readonly orders = new Map<string, number>();
    private readonly persisted = new Set<string>();
    private readonly items = new Map<string, Item>();

    /** 等价于 room.ts 收到 session 的 `{ type: 'item' }` */
    emit(item: Item): void {
        const order = this.orders.get(item.id) ?? (this.orderSeq += 1);
        this.orders.set(item.id, order);
        const existing = this.items.get(item.id);
        // 落过库的条目保持它第一次落库时的 seq（之后只是内存里的修订）
        const seq = existing?.seq ?? 0;
        const withOrder: Item = { ...item, order, seq };
        if ((item.status === 'done' || item.status === 'failed') && !this.persisted.has(item.id)) {
            this.persisted.add(item.id);
            this.items.set(item.id, { ...withOrder, seq: (this.storeSeq += 1) });
            return;
        }
        this.items.set(item.id, withOrder);
    }

    /** 当前内存里的一条时间线（按出现的先后，和 `chat-core` 的展示顺序同一口径） */
    live(): Item[] {
        return [...this.items.values()].sort(
            (left, right) => (left.order ?? 0) - (right.order ?? 0) || left.seq - right.seq,
        );
    }

    /** 刷新后还在的条目（只含落过库的）—— streaming 的条目不在里面 */
    durable(): Item[] {
        return this.live().filter((item) => this.persisted.has(item.id));
    }
}

/** 真 Projector 重放：`finish=true` 时把还在 streaming 的条目按 session 的做法收尾 */
function project(events: readonly AgentEvent[], finish: boolean): Item[] {
    const projector = new Projector(BOT, 1);
    const ledger = new ItemLedger();
    for (const event of events) {
        for (const item of projector.apply(event)) ledger.emit(item);
    }
    if (finish) for (const item of projector.finalize()) ledger.emit(item);
    return ledger.live();
}

/** 一条场景 → 它在这一版代码里的实际下场（判据 + 条目 + 建议 + 修复前对照） */
export function replay(scenario: StopScenario): StopReplay {
    const facts = factsOf(scenario);
    const reason = endReasonOf(facts);

    const failureMessage = scenario.events.find((event) => event.type === 'run.failed');
    // 与 session 同一顺序：事件 → 收尾（finalize）→ 判据补的 notice/error
    const projector = new Projector(BOT, 1);
    const ledger = new ItemLedger();
    let errorReported = false;
    for (const event of scenario.events) {
        for (const item of projector.apply(event)) {
            if (item.type === 'error') errorReported = true;
            ledger.emit(item);
        }
    }
    for (const item of projector.finalize()) ledger.emit(item);
    for (const item of endItems(
        reason,
        {
            turn: 1,
            turnId: TURN_ID,
            at: 1762400000000,
            ...(failureMessage?.type === 'run.failed' ? { failureMessage: failureMessage.message } : {}),
        },
        { errorAlreadyReported: errorReported },
    ))
        ledger.emit(item);

    return {
        scenario,
        facts,
        reason,
        items: ledger.live(),
        advice: adviceOf(reason),
        publishable: publishable(reason),
        legacy: {
            // 修复前：只区分「跑没跑成」。截断 / 没说完 / 工具悬空的一律显示"完成"，
            // 还在 streaming 的条目也没人收尾（工具行永远转圈）。
            label: facts.failed === true ? '失败' : '完成',
            items: project(scenario.events, false),
        },
    };
}

// ── 样本 ────────────────────────────────────────────────────────
//
// 事件流照 `agent.ts::runAgent` 的真实顺序写：`run.started` → 内容 → `run.finished`
// → `message.completed` → `run.completed`；失败路径则 `run.failed` 后直接 return。

const HALF_SENTENCE = '我先读一下 room.ts。第一处要改的是判';

export const STOP_SCENARIOS: readonly StopScenario[] = [
    {
        id: 'completed',
        title: '正常说完（对照组）',
        trigger: '模型把话说完，上游 finishReason=stop',
        expect: 'completed',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: '看完了 room.ts：' },
            { seq: 3, type: 'text.delta', messageId: 'msg-1', delta: '并发问题在 drainPending 里，已经改好。' },
            { seq: 4, type: 'run.finished', turnId: TURN_ID, finishReason: 'stop', steps: 1, maxOutputTokens: BUDGET },
            { seq: 5, type: 'message.completed', messageId: 'msg-1' },
            { seq: 6, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'max-tokens',
        title: '被输出上限截断',
        trigger: `模型正写到一半就撞了 maxOutputTokens（${BUDGET}），上游 finishReason=length`,
        expect: 'max-tokens',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: HALF_SENTENCE },
            {
                seq: 3,
                type: 'run.finished',
                turnId: TURN_ID,
                finishReason: 'length',
                steps: 1,
                maxOutputTokens: BUDGET,
            },
            { seq: 4, type: 'message.completed', messageId: 'msg-1' },
            { seq: 5, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'error-after-partial',
        title: '说了半句就崩了',
        trigger: '已经流出了半句话，上游随后抛错 / 给了 error part → run.failed',
        expect: 'error',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: HALF_SENTENCE },
            { seq: 3, type: 'run.failed', turnId: TURN_ID, message: 'upstream: 529 overloaded（网关侧）' },
        ],
    },
    {
        id: 'tool-error-but-finished',
        title: '工具报错，但这一轮正常说完（易误判）',
        trigger: '工具执行失败（tool.completed 带 error），模型看到了错误并继续说完了 —— finishReason=stop',
        expect: 'completed',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: '我跑一下测试：' },
            {
                seq: 3,
                type: 'tool.started',
                turnId: TURN_ID,
                toolCallId: 'call-1',
                name: 'bash',
                args: { command: 'npx vitest run' },
            },
            {
                seq: 4,
                type: 'tool.completed',
                turnId: TURN_ID,
                toolCallId: 'call-1',
                name: 'bash',
                error: 'exit 1: 2 tests failed',
            },
            {
                seq: 5,
                type: 'text.delta',
                messageId: 'msg-1',
                delta: '有 2 条红，是 end-footer 的断言过期了，我改一下。',
            },
            { seq: 6, type: 'run.finished', turnId: TURN_ID, finishReason: 'stop', steps: 2, maxOutputTokens: BUDGET },
            { seq: 7, type: 'message.completed', messageId: 'msg-1' },
            { seq: 8, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'thread-cut',
        title: '流被掐断（没收到收尾信号）',
        trigger: '进程被杀 / SSE 断 / 网关超时：事件流到一半就没有了，没有 run.finished',
        expect: 'unknown',
        expectNote: 'no-finish',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: HALF_SENTENCE },
            // 就这样断了 —— 没有任何收尾事件
        ],
    },
    {
        id: 'empty-output',
        title: '一个字没说就结束',
        trigger: 'finishReason=stop，但既没有文本也没有工具调用（可疑的静默停）',
        expect: 'unknown',
        expectNote: 'empty-output',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'run.finished', turnId: TURN_ID, finishReason: 'stop', steps: 1, maxOutputTokens: BUDGET },
            { seq: 3, type: 'message.completed', messageId: 'msg-1' },
            { seq: 4, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'weird-finish',
        title: '上游给了不认识的 finishReason',
        trigger: '换网关 / 换 provider 后上游冒出 `eos`、空串之类我们没见过的词',
        expect: 'unknown',
        expectNote: 'finish=eos',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: HALF_SENTENCE },
            { seq: 3, type: 'run.finished', turnId: TURN_ID, finishReason: 'eos', steps: 1, maxOutputTokens: BUDGET },
            { seq: 4, type: 'message.completed', messageId: 'msg-1' },
            { seq: 5, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'tool-mismatch',
        title: '工具结果没回来',
        trigger: '模型发了工具调用，结果没回来就收尾了（finishReason=tool-calls）',
        expect: 'tool-mismatch',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: '我来跑一下测试：' },
            {
                seq: 3,
                type: 'tool.started',
                turnId: TURN_ID,
                toolCallId: 'call-1',
                name: 'bash',
                args: { command: 'npx vitest run' },
            },
            { seq: 4, type: 'message.completed', messageId: 'msg-1' },
            {
                seq: 5,
                type: 'run.finished',
                turnId: TURN_ID,
                finishReason: 'tool-calls',
                steps: 1,
                maxOutputTokens: BUDGET,
            },
            { seq: 6, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'aborted',
        title: '人按了停',
        trigger: '用户点「停止本轮」→ abort signal → 上游 finishReason=aborted',
        expect: 'interrupted',
        aborted: true,
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: '先把 ask 的超时改成' },
            {
                seq: 3,
                type: 'tool.started',
                turnId: TURN_ID,
                toolCallId: 'call-1',
                name: 'edit',
                args: { path: 'src/ask.ts' },
            },
            {
                seq: 4,
                type: 'run.finished',
                turnId: TURN_ID,
                finishReason: 'aborted',
                steps: 1,
                maxOutputTokens: BUDGET,
            },
            { seq: 5, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'filtered',
        title: '被内容策略拦截',
        trigger: '上游 finishReason=content-filter',
        expect: 'filtered',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: '这段我' },
            {
                seq: 3,
                type: 'run.finished',
                turnId: TURN_ID,
                finishReason: 'content-filter',
                steps: 1,
                maxOutputTokens: BUDGET,
            },
            { seq: 4, type: 'message.completed', messageId: 'msg-1' },
            { seq: 5, type: 'run.completed', turnId: TURN_ID },
        ],
    },
    {
        id: 'upstream-stall',
        title: '上游静默，被 StallWatchdog 判超时中止（不是一般 error）',
        trigger:
            '网关连上了不吐字节 / 流中途静默 → agent 层的 StallWatchdog 到点 abort，' +
            'run.failed 带 stall（卡在哪个时段 / 等了多久）',
        expect: 'stalled',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            {
                seq: 2,
                type: 'run.failed',
                turnId: TURN_ID,
                message: '上游停摆：请求发出后一直没有收到任何数据（已等 180s），本轮已中止',
                stall: { phase: 'first', waitedMs: 180_000 },
            },
        ],
    },
    {
        id: 'error',
        title: '运行直接失败（对照组）',
        trigger: '401 密钥错 / 网络断 / 库坏：抛异常或 SDK 给 error part → run.failed',
        expect: 'error',
        events: [
            { seq: 1, type: 'run.started', turnId: TURN_ID, messageId: 'msg-1' },
            { seq: 2, type: 'run.failed', turnId: TURN_ID, message: '401 Invalid API key（检查 DEEPSEEK_API_KEY）' },
        ],
    },
];
