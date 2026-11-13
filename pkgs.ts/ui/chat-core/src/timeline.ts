// timeline.ts —— Item[] → 时间线（唯一分组逻辑，两个 surface 共用）。
//
// 为什么要这一层：Item 是**事件级**的（一条文本、一次工具调用各一条），而 UI 需要的是
// "一条消息"。分组的坑在多 agent 并发时暴露：
//   - 同一轮不同 bot 的 item 按 order 交错 → 必须按 (turnId, authorId) 聚合，不能按相邻性切段
//   - 同一 bot 的工具与文本要留在同一条里，且保持原有先后（text → tool → text）
// surface 只做「时间线 → 自己的组件」，不再各写一遍分组，语义差异从结构上消失。

import type { Author, Bot, Delivery, DeliveryState, Item } from './types';

export type TimelinePart =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; id: string; name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' };

export interface TimelineDelivery {
    botId: string;
    name: string;
    color: string;
    state: DeliveryState;
}

export interface TimelineEntry {
    /** 稳定 key（React key / 测试锚点）：用户与提示是 item id，bot 消息是 turnId:authorId */
    key: string;
    kind: 'user' | 'assistant' | 'notice' | 'error';
    turnId: string;
    author?: Author;
    parts: TimelinePart[];
    /** 有任一 item 仍在流式 */
    streaming: boolean;
    /** 仅 user 条目：这条消息投给了谁、到没到 */
    deliveries: TimelineDelivery[];
    at: number;
}

function partOf(item: Item): TimelinePart | undefined {
    if (item.type === 'chat') return { kind: 'text', text: item.data.text };
    if (item.type === 'tool') {
        return {
            kind: 'tool',
            id: item.id,
            name: item.data.name,
            args: item.data.args,
            result: item.data.result,
            state: item.data.state,
        };
    }
    return undefined;
}

function chipsOf(deliveries: readonly Delivery[], bots: Record<string, Bot>, messageId: string): TimelineDelivery[] {
    return deliveries
        .filter((delivery) => delivery.messageId === messageId)
        .map((delivery) => {
            const bot = bots[delivery.botId];
            return {
                botId: delivery.botId,
                name: bot?.name ?? delivery.botId,
                color: bot?.color ?? '#9ca3af',
                state: delivery.state,
            };
        });
}

export function buildTimeline(
    items: readonly Item[],
    deliveries: readonly Delivery[] = [],
    bots: Record<string, Bot> = {},
): TimelineEntry[] {
    const entries: TimelineEntry[] = [];
    const byKey = new Map<string, TimelineEntry>();

    for (const item of items) {
        if (item.type === 'notice') {
            entries.push({
                key: item.id,
                kind: 'notice',
                turnId: item.turnId,
                parts: [{ kind: 'text', text: item.data.text }],
                streaming: false,
                deliveries: [],
                at: item.at,
            });
            continue;
        }

        if (item.type === 'error') {
            entries.push({
                key: item.id,
                kind: 'error',
                turnId: item.turnId,
                parts: [{ kind: 'text', text: item.data.message }],
                streaming: false,
                deliveries: [],
                at: item.at,
            });
            continue;
        }

        const author = item.author;

        if (author?.role === 'human') {
            entries.push({
                key: item.id,
                kind: 'user',
                turnId: item.turnId,
                author,
                parts: [{ kind: 'text', text: item.type === 'chat' ? item.data.text : '' }],
                streaming: false,
                deliveries: chipsOf(deliveries, bots, item.id),
                at: item.at,
            });
            continue;
        }

        const key = `${item.turnId}:${author?.id ?? 'unknown'}`;
        let entry = byKey.get(key);
        if (entry === undefined) {
            entry = { key, kind: 'assistant', turnId: item.turnId, author, parts: [], streaming: false, deliveries: [], at: item.at };
            byKey.set(key, entry);
            entries.push(entry);
        }
        const part = partOf(item);
        if (part !== undefined) entry.parts.push(part);
        if (item.status === 'streaming') entry.streaming = true;
    }

    return entries;
}
