// projection.ts —— 时间线 → ThreadMessageLike（assistant-ui 的出口）。
//
// 分组逻辑在 chat-core 的 buildTimeline（与 Astryx surface 共用），这里只做形状转换。

import { buildTimeline, type TimelineEntry } from '@diy-agent/chat-core';
import type { ThreadMessageLike } from '@assistant-ui/react';

import type { Bot, Delivery, Item } from './model';

export interface DeliveryChip {
    botId: string;
    name: string;
    color: string;
    state: string;
}

export interface CustomMeta {
    [key: string]: unknown;
    kind: 'chat' | 'notice' | 'error';
    author?: TimelineEntry['author'];
    deliveries?: DeliveryChip[];
    /** 当前房间：头像按项目/任务取图标 */
    roomId?: string;
}

const completeStatus: ThreadMessageLike['status'] = { type: 'complete', reason: 'stop' };
const runningStatus: ThreadMessageLike['status'] = { type: 'running' };

type Part = NonNullable<ThreadMessageLike['content']> extends string ? never : Exclude<ThreadMessageLike['content'], string>[number];

function partsOf(entry: TimelineEntry): Part[] {
    return entry.parts.map((part) =>
        part.kind === 'text'
            ? { type: 'text', text: part.text }
            : {
                  type: 'tool-call',
                  toolCallId: part.id,
                  toolName: part.name,
                  args: (part.args ?? {}) as never,
                  result: part.result,
                  isError: part.state === 'error',
              },
    );
}

export function toThreadMessages(
    items: Item[],
    deliveries: readonly Delivery[] = [],
    bots: Record<string, Bot> = {},
    roomId?: string,
): ThreadMessageLike[] {
    return buildTimeline(items, deliveries, bots).map((entry) => {
        const createdAt = new Date(entry.at);
        const status = entry.streaming ? runningStatus : completeStatus;

        if (entry.kind === 'user') {
            const custom: CustomMeta = {
                kind: 'chat',
                author: entry.author,
                ...(roomId === undefined ? {} : { roomId }),
                ...(entry.deliveries.length > 0 ? { deliveries: entry.deliveries } : {}),
            };
            return {
                id: entry.key,
                createdAt,
                role: 'user',
                content: [{ type: 'text', text: entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('') }],
                metadata: { custom },
            };
        }

        if (entry.kind === 'notice' || entry.kind === 'error') {
            return {
                id: entry.key,
                createdAt,
                role: 'assistant',
                content: partsOf(entry),
                status: completeStatus,
                metadata: { custom: { kind: entry.kind } satisfies CustomMeta },
            };
        }

        return {
            id: entry.key,
            createdAt,
            role: 'assistant',
            content: partsOf(entry),
            status,
            metadata: { custom: { kind: 'chat', author: entry.author, ...(roomId === undefined ? {} : { roomId }) } satisfies CustomMeta },
        };
    });
}
