// reduce.ts —— 纯函数：StreamEvent → 状态。UI 与 surface 都不自己拼消息。

import { normalizeAskRequest } from '@diy-agent/protocol';

import type { BotProgress } from './progress';
import type { TurnFacts } from './timeline';
import type { AnsweredAsk, AskRequest, CompactionProgress, Delivery, Item, StreamEvent } from './types';

export interface ConversationState {
    items: Item[];
    /**
     * 服务端只给了**最近一截**（上面还有更早的没加载）：界面据此显示「加载更早的 N 条」。
     *
     * 背景（2026-11-26 实测）：6000+ 条的房间里全量 `chat.history` 回包 5.7 MB，
     * JSON.parse + 渲染就是 2~5 秒的长任务；现在默认只发最近 400 条。
     */
    truncated?: boolean;
    /** 这个房间一共有多少条 item（配合 `truncated` 说“上面还有多少”） */
    totalItems?: number;
    deliveries: Delivery[];
    /** 正在等用户回答的提问 */
    asks: AskRequest[];
    /** 已经有结局的提问（最近若干条）：卡片留在时间线上显示已选状态 */
    answered: AnsweredAsk[];
    seq: number;
    error?: string;
    /** 有成员正在跑（surface 用它显示停止按钮） */
    running: boolean;
    /** 正在说话的成员 id（房间广播，按成员顺序） */
    speaking: string[];
    /**
     * 各轮的时间与结局（`turnId\u0000botId` → 事实）。消息头写开始时刻、底部行写
     * 「已用 / 结算」，两者读的都是它。
     *
     * 运行中的轮只有 `startedAt`（来自 `turn.start` 或快照的 `runningTurns`），
     * 收尾时随 `turn.end` 补齐 `endedAt` / `usage` / `reason`。
     *
     * 会不会无限长大：每轮一条，与「这次连接里跑过多少轮」同阶；刷新即清。
     */
    turns: Record<string, TurnFacts>;
    /**
     * 每个成员此刻的进展（`progress` 事件给的事实：在等谁 / 多久没动 / 有无心跳）。
     *
     * ephemeral：快照里没有。刷新后最多 5 秒就会被下一条 tick 刷回来；
     * 那一小段空白里 UI 退回旧的「执行中 Ns」（条目的 at 还在），不会更差。
     */
    progress: Record<string, BotProgress>;
    /**
     * 手动的压缩，按 compactId 归并（`running` 那条会被同 id 的终态覆盖）。
     *
     * 为什么存在会话状态里：压缩点下去要等好几秒，而 RPC 是同步等的 —— 反馈只能靠事件。
     * 自动压缩不进这里（它是轮次里的内部动作，广播出来只是噪点）。
     */
    compactions: Record<string, CompactionProgress>;
}

export function emptyState(): ConversationState {
    return {
        items: [],
        deliveries: [],
        asks: [],
        answered: [],
        seq: 0,
        running: false,
        speaking: [],
        turns: {},
        progress: {},
        compactions: {},
    };
}

const STATUS_RANK: Record<Item['status'], number> = { pending: 0, streaming: 1, done: 2, failed: 2 };

/** 压缩进度最多留几条（只有手动压缩会进来，面板也就看最近几次） */
const MAX_COMPACTIONS = 8;

/** 两条流（post 的 + 常驻的）都往这里送，乱序时别让旧事件把新状态回滚 */
function isStale(current: Item, next: Item): boolean {
    if (STATUS_RANK[next.status] < STATUS_RANK[current.status]) return true;
    if (current.type === 'chat' && next.type === 'chat' && next.data.text.length < current.data.text.length)
        return true;
    return false;
}

function sortItems(items: Item[]): Item[] {
    return [...items].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || (a.order ?? a.seq) - (b.order ?? b.seq));
}

export function applyEvent(state: ConversationState, event: StreamEvent): ConversationState {
    switch (event.kind) {
        case 'item': {
            const item = event.item;
            const index = state.items.findIndex((existing) => existing.id === item.id);
            if (index >= 0 && isStale(state.items[index]!, item)) {
                return { ...state, seq: Math.max(state.seq, item.seq) };
            }
            const items =
                index < 0
                    ? [...state.items, item]
                    : state.items.map((existing) => (existing.id === item.id ? item : existing));
            const next = sortItems(items);
            return {
                ...state,
                items: next,
                seq: Math.max(state.seq, item.seq),
                // running 只认服务端的 running 事件：从 item 推会出错 ——
                // A 收尾的最后一条 item 一到就算 false，而 B 还在说 → 停止按钮会闪。
                // （快照初值在 fromSnapshot 里单独推一次，之后以事件为准。）
            };
        }
        case 'delivery': {
            const delivery = event.delivery;
            const index = state.deliveries.findIndex(
                (existing) => existing.messageId === delivery.messageId && existing.botId === delivery.botId,
            );
            const deliveries =
                index < 0
                    ? [...state.deliveries, delivery]
                    : state.deliveries.map((existing) =>
                          existing.messageId === delivery.messageId && existing.botId === delivery.botId
                              ? delivery
                              : existing,
                      );
            return { ...state, deliveries };
        }
        case 'running':
            return { ...state, speaking: event.botIds, running: event.botIds.length > 0 };
        case 'progress':
            return {
                ...state,
                progress: {
                    ...state.progress,
                    [event.botId]: {
                        awaiting: event.awaiting,
                        idleMs: event.idleMs,
                        // 客户端收到时刻：自走从这里起算（不用服务端时钟）
                        at: Date.now(),
                        alive: event.alive,
                        stage: event.stage,
                    },
                },
            };
        case 'compact': {
            // 同 id 覆盖：`running` → 终态是一条链，不是两条记录
            const merged = { ...state.compactions, [event.compact.compactId]: event.compact };
            const all = Object.values(merged);
            if (all.length <= MAX_COMPACTIONS) return { ...state, compactions: merged };
            // 长期开着页面底栏会累积：只留最近几条（running 的必然在最新里）
            const kept = all.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_COMPACTIONS);
            return { ...state, compactions: Object.fromEntries(kept.map((entry) => [entry.compactId, entry])) };
        }
        case 'turn.start':
            // 开轮：先只记开始时刻。消息头与「已用 Ns」立刻有值，不必等第一条内容。
            // key 必须带 botId：同一轮里多个 bot 各跑各的，只按 turnId 存会互相覆盖。
            return {
                ...state,
                turns: {
                    ...state.turns,
                    [`${event.turnId}\u0000${event.botId}`]: {
                        ...state.turns[`${event.turnId}\u0000${event.botId}`],
                        startedAt: event.startedAt,
                    },
                },
            };
        case 'turn.end': {
            // 收尾后这一轮的进展事实就作废（不清的话，下一轮开始前 indicator 会闪一下旧文案）
            const progress = { ...state.progress };
            delete progress[event.botId];
            const key = `${event.turnId}\u0000${event.botId}`;
            return {
                ...state,
                progress,
                turns: {
                    ...state.turns,
                    [key]: {
                        ...state.turns[key],
                        // 服务端给的开始时刻优先；老服务端没给就沿用 turn.start 那个
                        ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
                        ...(event.endedAt === undefined ? {} : { endedAt: event.endedAt }),
                        ...(event.usage === undefined ? {} : { usage: event.usage }),
                        ...(event.toolCalls === undefined ? {} : { toolCalls: event.toolCalls }),
                        reason: event.reason,
                    },
                },
            };
        }
        case 'ask': {
            const exists = state.asks.some((entry) => entry.askId === event.request.askId);
            const asks = exists ? state.asks : [...state.asks, event.request];
            return { ...state, asks };
        }
        case 'ask.answered': {
            // 卡片不消失：搬进 answered，界面把它渲染成「已选」的只读状态。
            // request 只能从已知的 pending 里找（事件只带 askId）；找不到就只删 ——
            // 刷新时由快照里的 answeredAsks 补齐，不会永久丢。
            const request = state.asks.find((entry) => entry.askId === event.askId);
            const answers =
                request === undefined
                    ? state.answered
                    : [
                          ...state.answered,
                          {
                              request,
                              ...(event.answer === undefined ? {} : { answer: event.answer }),
                              ...(event.cancelled === true ? { cancelled: true } : {}),
                              ...(event.expired === true ? { expired: true } : {}),
                              ...(event.reason === undefined ? {} : { reason: event.reason }),
                              at: Date.now(),
                          },
                      ];
            return { ...state, asks: state.asks.filter((entry) => entry.askId !== event.askId), answered: answers };
        }
        case 'error':
            return { ...state, error: event.message, running: false };
        case 'done':
            return { ...state, running: false, speaking: [], progress: {} };
        default:
            return state;
    }
}

function normalizeRequests(asks: readonly AskRequest[] | undefined): AskRequest[] {
    return (asks ?? []).flatMap((entry) => normalizeAskRequest(entry) ?? []);
}

/** 历史快照 → 初始状态（按 seq 去重，刷新/重放同一入口） */
export function fromSnapshot(snapshot: {
    items: Item[];
    deliveries: Delivery[];
    asks?: AskRequest[];
    answeredAsks?: AnsweredAsk[];
    speaking?: string[];
    runningTurns?: Array<{ botId: string; turnId: string; startedAt: number }>;
    /**
     * 跑过的每一轮的结算事实（服务端落盘那份）。
     *
     * 不填这个的后果是：刷新后历史轮次没有 `endedAt` → `turnSettleOf` 返 undefined →
     * `TurnFooter` 整行不渲染（时长 / tokens / 步数全没）。
     */
    turnFacts?: Array<{
        botId: string;
        turnId: string;
        turn: number;
        startedAt?: number;
        endedAt: number;
        usage?: TurnFacts['usage'];
        toolCalls?: number;
        reason?: TurnFacts['reason'];
    }>;
    /** 这个房间一共多少条（分页提示用；缺省 = 老服务端 / 已全量） */
    totalItems?: number;
    /** 服务端只给了最近一截（`items` 不是从第一条开始） */
    truncated?: boolean;
}): ConversationState {
    // 同 id 只留最新一条（append-only 更新：重跑的 item 会以新 seq 再写一遍）
    const latest = new Map<string, Item>();
    for (const item of snapshot.items) {
        const existing = latest.get(item.id);
        if (existing === undefined || item.seq >= existing.seq) latest.set(item.id, item);
    }
    const items = sortItems([...latest.values()]);
    // 谁在跑：**优先服务端事实**（`Snapshot.speaking`，与运行中广播同源）。
    //
    // 为什么不再只靠倒推：一轮卡在等上游首个字时没有任何流式条目 —— 刷新后倒推出
    // 空列表，于是没有「正在说话…」、也没有停止按钮，用户看不出它在跑、更停不掉
    // （2026-11-23 实测）。倒推只留给老服务端（快照不带 speaking）当兜底。
    const speaking =
        snapshot.speaking ??
        [...new Set(items.filter((item) => item.status === 'streaming').map((item) => item.author?.id ?? ''))].filter(
            (id) => id !== '',
        );
    return {
        items,
        // 分页元信息：界面靠它说“上面还有更早的”，用户点一下才全量拉（`reload(0)`）
        ...(snapshot.totalItems === undefined ? {} : { totalItems: snapshot.totalItems }),
        ...(snapshot.truncated === true ? { truncated: true } : {}),
        deliveries: snapshot.deliveries,
        // 快照里的卡片可能是旧形状（一批问题之前是"一个问题"）：不归一则刷新后渲不出来，
        // 而它们正是用户回头核对"当时我选了哪个"的唯一线索
        asks: normalizeRequests(snapshot.asks),
        answered: (snapshot.answeredAsks ?? []).flatMap((entry) => {
            const request = normalizeAskRequest(entry.request);
            return request === undefined ? [] : [{ ...entry, request }];
        }),
        seq: Math.max(0, ...snapshot.items.map((item) => item.seq)),
        running: speaking.length > 0,
        speaking,
        // 刷新后 `turn.start` / `turn.end` 都丢了，所以 turns 有**两个**来源：
        //   ① `turnFacts` —— 服务端落盘的每一轮的账（耗时 / tokens / 步数 / 怎么结束的）：
        //      结算行靠它。**这就是 11-27 用户报「轮次下的时间 / 汇总 / token 都没了」的根因**：
        //      之前这里只填 ②，正常完成的轮次一条 notice 都不落（`endFooterOf(completed)`
        //      返 undefined），于是历史轮次整行空。
        //   ② `runningTurns` —— 在跑的那几轮只有开始时刻（它们还没有账）。
        // 先后：② 覆盖 ①（在跑的轮若有旧账，以「现在这轮」为准）。
        turns: {
            ...Object.fromEntries(
                (snapshot.turnFacts ?? []).map((fact) => [
                    `${fact.turnId}\u0000${fact.botId}`,
                    {
                        ...(fact.startedAt === undefined ? {} : { startedAt: fact.startedAt }),
                        endedAt: fact.endedAt,
                        ...(fact.usage === undefined ? {} : { usage: fact.usage }),
                        ...(fact.toolCalls === undefined ? {} : { toolCalls: fact.toolCalls }),
                        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
                    } satisfies TurnFacts,
                ]),
            ),
            ...Object.fromEntries(
                (snapshot.runningTurns ?? []).map((turn) => [
                    `${turn.turnId}\u0000${turn.botId}`,
                    { startedAt: turn.startedAt } satisfies TurnFacts,
                ]),
            ),
        },
        // 同理：进展事实也只在连接里活，刷完等第一条 tick（≤5s）再回来
        progress: {},
        // 压缩进度同理：做完的那次已体现在 stats 里（摘要 / 折叠数），中途的那次刷新就没了
        compactions: {},
    };
}
