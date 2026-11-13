// reduce.ts —— 纯函数：StreamEvent → 状态。UI 与 surface 都不自己拼消息。

import type { Delivery, Item, StreamEvent } from './types';

export interface ConversationState {
    items: Item[];
    deliveries: Delivery[];
    seq: number;
    error?: string;
    /** 有流式消息即 running（surface 用它显示停止按钮） */
    running: boolean;
}

export function emptyState(): ConversationState {
    return { items: [], deliveries: [], seq: 0, running: false };
}

function sortItems(items: Item[]): Item[] {
    return [...items].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || (a.order ?? a.seq) - (b.order ?? b.seq));
}

export function applyEvent(state: ConversationState, event: StreamEvent): ConversationState {
    switch (event.kind) {
        case 'item': {
            const item = event.item;
            const index = state.items.findIndex((existing) => existing.id === item.id);
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
        case 'error':
            return { ...state, error: event.message, running: false };
        case 'done':
            return { ...state, running: false };
        default:
            return state;
    }
}

/** 历史快照 → 初始状态（按 seq 去重，刷新/重放同一入口） */
export function fromSnapshot(snapshot: { items: Item[]; deliveries: Delivery[] }): ConversationState {
    return {
        items: sortItems(snapshot.items),
        deliveries: snapshot.deliveries,
        seq: Math.max(0, ...snapshot.items.map((item) => item.seq)),
        running: snapshot.items.some((item) => item.status === 'streaming'),
    };
}
