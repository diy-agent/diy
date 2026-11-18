// reduce.ts —— 纯函数：StreamEvent → 状态。UI 与 surface 都不自己拼消息。

import { normalizeAskRequest } from '@diy-agent/protocol';

import type { AnsweredAsk, AskRequest, Delivery, Item, StreamEvent, TurnEndReason } from './types';

export interface ConversationState {
    items: Item[];
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
     * 某一轮**为什么**结束（turnId → 判定）。页脚用它显示结局。
     *
     * 只活在这一次连接里（快照里没有它）：`completed` 本来不需要页脚，
     * 需要解释的那几种在时间线上都有持久条目 —— 刷新后信息不会丢，只是页脚那行会消失。
     */
    turnEnds: Record<string, TurnEndReason>;
}

export function emptyState(): ConversationState {
    return { items: [], deliveries: [], asks: [], answered: [], seq: 0, running: false, speaking: [], turnEnds: {} };
}

const STATUS_RANK: Record<Item['status'], number> = { pending: 0, streaming: 1, done: 2, failed: 2 };

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
        case 'turn.end':
            // key 必须带 botId：同一轮里多个 bot 各跑各的，只按 turnId 存会互相覆盖 ——
            // A 被截断、B 正常说完时，A 的页脚会显示成 B 的结局
            return {
                ...state,
                turnEnds: { ...state.turnEnds, [`${event.turnId}\u0000${event.botId}`]: event.reason },
            };
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
                              ...(event.reason === undefined ? {} : { reason: event.reason }),
                              at: Date.now(),
                          },
                      ];
            return { ...state, asks: state.asks.filter((entry) => entry.askId !== event.askId), answered: answers };
        }
        case 'error':
            return { ...state, error: event.message, running: false };
        case 'done':
            return { ...state, running: false, speaking: [] };
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
}): ConversationState {
    // 同 id 只留最新一条（append-only 更新：重跑的 item 会以新 seq 再写一遍）
    const latest = new Map<string, Item>();
    for (const item of snapshot.items) {
        const existing = latest.get(item.id);
        if (existing === undefined || item.seq >= existing.seq) latest.set(item.id, item);
    }
    const items = sortItems([...latest.values()]);
    // 快照里没有 running 事件：从"还在流式的 bot 条目"倒推一个初值，后续以服务端事件为准
    const speaking = [
        ...new Set(items.filter((item) => item.status === 'streaming').map((item) => item.author?.id ?? '')),
    ].filter((id) => id !== '');
    return {
        items,
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
        // 快照不带 endReason：它是这一次连接里的事实，不是历史数据。
        turnEnds: {},
    };
}
