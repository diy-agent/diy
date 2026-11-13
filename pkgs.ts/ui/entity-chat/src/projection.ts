// projection.ts —— Item[] → ThreadMessageLike[]（UI 唯一出口）。
//
// 关键：assistant-ui 的一条消息可以含多个 part（text / tool-call / reasoning）。
// 我们的 Item 是"事件级"（一条 text、一条 tool 各自一个 Item），所以这里按 turnId
// 把同一轮的 text 与 tool **合并进同一条消息**——否则会出现两条独立气泡。

import type { ThreadMessageLike } from '@assistant-ui/react';

import type { Author, Bot, Delivery, Item } from './model';

export interface DeliveryChip {
    botId: string;
    name: string;
    color: string;
    state: string;
}

export interface CustomMeta {
    kind: 'chat' | 'notice';
    author?: Author;
    deliveries?: DeliveryChip[];
}

const completeStatus: ThreadMessageLike['status'] = { type: 'complete', reason: 'stop' };
const runningStatus: ThreadMessageLike['status'] = { type: 'running' };

type Part = NonNullable<ThreadMessageLike['content']> extends string ? never : Exclude<ThreadMessageLike['content'], string>[number];

function partOf(item: Item): Part | undefined {
    if (item.type === 'chat') return { type: 'text', text: item.data.text };
    if (item.type === 'error') return { type: 'text', text: item.data.message };
    if (item.type === 'tool') {
        return {
            type: 'tool-call',
            toolCallId: item.id,
            toolName: item.data.name,
            args: (item.data.args ?? {}) as never,
            result: item.data.result,
            isError: item.data.state === 'error',
        };
    }
    return undefined;
}

export function toThreadMessages(
    items: Item[],
    deliveries: readonly Delivery[] = [],
    bots: Record<string, Bot> = {},
): ThreadMessageLike[] {
    const out: { turnId: string; authorId?: string; message: ThreadMessageLike }[] = [];

    for (const item of items) {
        const createdAt = new Date(item.at);
        const author = item.author;

        if (item.type === 'notice') {
            out.push({
                turnId: item.turnId,
                message: {
                    id: item.id,
                    createdAt,
                    role: 'assistant',
                    content: [{ type: 'text', text: item.data.text }],
                    status: completeStatus,
                    metadata: { custom: { kind: 'notice' } satisfies CustomMeta },
                },
            });
            continue;
        }

        if (author?.role === 'human') {
            const chips: DeliveryChip[] = deliveries
                .filter((delivery) => delivery.messageId === item.id)
                .map((delivery) => {
                    const bot = bots[delivery.botId];
                    return {
                        botId: delivery.botId,
                        name: bot?.name ?? delivery.botId,
                        color: bot?.color ?? '#9ca3af',
                        state: delivery.state,
                    };
                });
            out.push({
                turnId: item.turnId,
                authorId: author.id,
                message: {
                    id: item.id,
                    createdAt,
                    role: 'user',
                    content: [{ type: 'text', text: item.type === 'chat' ? item.data.text : '' }],
                    metadata: { custom: { kind: 'chat', author, ...(chips.length > 0 ? { deliveries: chips } : {}) } satisfies CustomMeta },
                },
            });
            continue;
        }

        const part = partOf(item);
        if (part === undefined) continue;

        const status = item.status === 'streaming' ? runningStatus : completeStatus;
        const last = out.at(-1);

        // 同一轮 + 同一个 bot：把 part 追加进上一条 assistant 消息（工具与文本不分离）。
        // 多 agent 并发时同轮有多个 bot，必须按 author 分开，否则会串成一条气泡。
        const authorId = author?.id;
        if (last !== undefined && last.turnId === item.turnId && last.authorId === authorId && last.message.role === 'assistant') {
            const content = [...(last.message.content as Part[]), part];
            out[out.length - 1] = {
                turnId: last.turnId,
                authorId,
                message: { ...last.message, content, status },
            };
            continue;
        }

        out.push({
            turnId: item.turnId,
            authorId,
            message: {
                id: item.id,
                createdAt,
                role: 'assistant',
                content: [part],
                status,
                metadata: { custom: { kind: 'chat', author } satisfies CustomMeta },
            },
        });
    }

    return out.map((entry) => entry.message);
}
