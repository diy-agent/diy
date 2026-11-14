// reduce.ts —— 纯函数：StreamEvent → 状态。UI 与 surface 都不自己拼消息。

import type { AskRequest, Delivery, Item, StreamEvent } from './types';

export interface ConversationState {
    items: Item[];
    deliveries: Delivery[];
    /** 正在等用户回答的提问 */
    asks: AskRequest[];
    seq: number;
    error?: string;
    /** 有成员正在跑（surface 用它显示停止按钮） */
    running: boolean;
    /** 正在说话的成员 id（房间广播，按成员顺序） */
    speaking: string[];
}

export function emptyState(): ConversationState {
    return { items: [], deliveries: [], asks: [], seq: 0, running: false, speaking: [] };
}

const STATUS_RANK: Record<Item['status'], number> = { pending: 0, streaming: 1, done: 2, failed: 2 };

/** 两条流（post 的 + 常驻的）都往这里送，乱序时别让旧事件把新状态回滚 */
function isStale(current: Item, next: Item): boolean {
    if (STATUS_RANK[next.status] < STATUS_RANK[current.status]) return true;
    if (current.type === 'chat' && next.type === 'chat' && next.data.text.length < current.data.text.length) return true;
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
            const items = index < 0 ? [...state.items, item] : state.items.map((existing) => (existing.id === item.id ? item : existing));
            const next = sortItems(items);
            return {
                ...state,
                items: next,
                seq: Math.max(state.seq, item.seq),
                running: next.some((entry) => entry.status === 'streaming'),
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
                          existing.messageId === delivery.messageId && existing.botId === delivery.botId ? delivery : existing,
                      );
            return { ...state, deliveries };
        }
        case 'running':
            return { ...state, speaking: event.botIds, running: event.botIds.length > 0 };
        case 'ask': {
            const exists = state.asks.some((entry) => entry.askId === event.request.askId);
            const asks = exists ? state.asks : [...state.asks, event.request];
            return { ...state, asks };
        }
        case 'ask.answered': {
            return { ...state, asks: state.asks.filter((entry) => entry.askId !== event.askId) };
        }
        case 'error':
            return { ...state, error: event.message, running: false };
        case 'done':
            return { ...state, running: false, speaking: [] };
        default:
            return state;
    }
}

/** 历史快照 → 初始状态（按 seq 去重，刷新/重放同一入口） */
export function fromSnapshot(snapshot: {
    items: Item[];
    deliveries: Delivery[];
    asks?: AskRequest[];
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
        asks: snapshot.asks ?? [],
        seq: Math.max(0, ...snapshot.items.map((item) => item.seq)),
        running: speaking.length > 0,
        speaking,
    };
}
