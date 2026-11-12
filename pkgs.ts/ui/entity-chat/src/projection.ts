// projection.ts —— Item → ThreadMessageLike（UI 唯一入口）。
//
// 这是本轮讨论里「投影」的最小实现：
//   真源 Item（type + data）→ 渲染 DTO（assistant-ui 的消息）
// author / kind 走 metadata.custom，不污染 assistant-ui 的 role。

import type { ThreadMessageLike } from '@assistant-ui/react';

import type { Author, Item } from './model';

export interface CustomMeta {
    kind: 'chat' | 'notice';
    author?: Author;
}

const completeStatus: ThreadMessageLike['status'] = { type: 'complete', reason: 'stop' };
const runningStatus: ThreadMessageLike['status'] = { type: 'running' };

export function toThreadMessages(items: Item[]): ThreadMessageLike[] {
    return items.map((item): ThreadMessageLike => {
        const createdAt = new Date(item.at);

        if (item.type === 'notice') {
            return {
                id: item.id,
                createdAt,
                role: 'assistant',
                content: [{ type: 'text', text: item.data.text }],
                status: completeStatus,
                metadata: { custom: { kind: 'notice' } satisfies CustomMeta },
            };
        }

        const author = item.author;
        const metadata = { custom: { kind: 'chat', author } satisfies CustomMeta };
        if (item.type === 'tool') {
            return {
                id: item.id,
                createdAt,
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: item.id,
                        toolName: item.data.name,
                        args: (item.data.args ?? {}) as never,
                        result: item.data.result,
                        isError: item.data.state === 'error',
                    },
                ],
                status: item.status === 'streaming' ? runningStatus : completeStatus,
                metadata,
            };
        }

        const text = item.type === 'chat' ? item.data.text : item.data.message;
        const content = [{ type: 'text' as const, text }];

        // user 消息不允许带 status（assistant-ui 的约束）
        if (author?.role === 'human') {
            return { id: item.id, createdAt, role: 'user', content, metadata };
        }
        return {
            id: item.id,
            createdAt,
            role: 'assistant',
            content,
            status: item.status === 'streaming' ? runningStatus : completeStatus,
            metadata,
        };
    });
}
