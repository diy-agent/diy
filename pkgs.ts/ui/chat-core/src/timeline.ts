// timeline.ts —— Item[] → 时间线（唯一分组逻辑，两个 surface 共用）。
//
// 为什么要这一层：Item 是**事件级**的（一条文本、一次工具调用各一条），而 UI 需要的是
// "一条消息"。分组的坑在多 agent 并发时暴露：
//   - 同一轮不同 bot 的 item 按 order 交错 → 必须按 (turnId, authorId) 聚合，不能按相邻性切段
//   - 同一 bot 的工具与文本要留在同一条里，且保持原有先后（text → tool → text）
// surface 只做「时间线 → 自己的组件」，不再各写一遍分组，语义差异从结构上消失。

import type { AskRequest, Author, Bot, Delivery, DeliveryState, Item } from './types';

export type TimelinePart =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; id: string; name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' }
    /** 需要用户回答的提问：渲染在触发它的那个工具行下面 */
    | { kind: 'ask'; request: AskRequest };

export interface TimelineDelivery {
    botId: string;
    name: string;
    color: string;
    state: DeliveryState;
}

export interface TimelineEntry {
    /** 稳定 key（React key / 测试锚点）：用户与提示是 item id，bot 消息是 turnId:authorId */
    key: string;
    /**
     * typing = 这个 bot 已经开跑但还没产出内容（"正在输入…"占位）。
     * 没有它，用户发完消息只会看到投递 chip，没有任何"bot 收到了"的反馈。
     */
    kind: 'user' | 'assistant' | 'notice' | 'error' | 'typing';
    turnId: string;
    author?: Author;
    parts: TimelinePart[];
    /** 有任一 item 仍在流式 */
    streaming: boolean;
    /**
     * 这个 bot 本轮还在跑，但当前没有任何流式内容（工具刚结束、下一段还没开始）。
     * 表现成这条消息末尾的"执行中 Ns"，而不是列表末尾单独一行 —— 否则工具行的
     * 转圈和它会在上下两个位置来回闪。
     */
    waiting?: boolean;
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
    options: { speaking?: readonly string[]; asks?: readonly AskRequest[] } = {},
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
                ...(item.author === undefined ? {} : { author: item.author }),
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
            entry = {
                key,
                kind: 'assistant',
                turnId: item.turnId,
                author,
                parts: [],
                streaming: false,
                deliveries: [],
                at: item.at,
            };
            byKey.set(key, entry);
            entries.push(entry);
        }
        const part = partOf(item);
        if (part !== undefined) entry.parts.push(part);
        if (item.status === 'streaming') entry.streaming = true;
    }

    // 待回答的提问：挂到触发它的工具行后面（找不到就挂到最后一条 assistant 条目）
    for (const ask of options.asks ?? []) {
        const part: TimelinePart = { kind: 'ask', request: ask };
        const target =
            (ask.toolCallId === undefined
                ? undefined
                : entries.find((entry) =>
                      entry.parts.some(
                          (candidate) => candidate.kind === 'tool' && candidate.id === `tool-${ask.toolCallId}`,
                      ),
                  )) ?? [...entries].reverse().find((entry) => entry.kind === 'assistant');
        if (target === undefined) continue;
        const index = target.parts.findIndex(
            (candidate) =>
                candidate.kind === 'tool' && ask.toolCallId !== undefined && candidate.id === `tool-${ask.toolCallId}`,
        );
        if (index >= 0) target.parts.splice(index + 1, 0, part);
        else target.parts.push(part);
    }

    // 正在跑但还没有任何流式内容的 bot：补一个"正在输入…"占位
    const streamingAuthors = new Set(
        entries.filter((entry) => entry.kind === 'assistant' && entry.streaming).map((entry) => entry.author?.id ?? ''),
    );
    const lastItem = items.at(-1);
    const turnId = lastItem?.turnId ?? '';
    // "开跑时刻" = 这一轮的**第一条** item（通常就是用户那条消息）。
    //  - 不能用 Date.now()：每次 rebuild 都变，秒数会来回跳；
    //  - 也不能用最后一条：工具跑完再进入思考时，秒数会被重置成 0。
    const turnStart = items.find((item) => item.turnId === turnId);
    const startedAt = turnStart?.at ?? lastItem?.at ?? Date.now();
    for (const botId of options.speaking ?? []) {
        if (streamingAuthors.has(botId)) continue;
        // 本轮已经产出过内容：把"还在跑"挂回它自己那条消息的末尾。
        // 单独补一条 typing 条目会让它在列表最底部出现，于是"工具行转圈 →
        // 执行中一行 → 工具行转圈"上下交错（每条 item 到达都会重排一次）。
        const own = entries.find(
            (entry) => entry.kind === 'assistant' && entry.turnId === turnId && entry.author?.id === botId,
        );
        if (own !== undefined) {
            own.waiting = true;
            continue;
        }
        const bot = bots[botId];
        entries.push({
            key: `typing:${botId}:${turnId}`,
            kind: 'typing',
            turnId,
            ...(bot === undefined
                ? {}
                : { author: { id: bot.id, name: bot.name, color: bot.color, role: 'bot' as const } }),
            parts: [],
            streaming: true,
            deliveries: [],
            at: startedAt,
        });
    }

    return entries;
}
