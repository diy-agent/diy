// projection.ts —— 时间线 → ThreadMessageLike（assistant-ui 的出口）。
//
// 分组逻辑在 chat-core 的 buildTimeline（与 Astryx surface 共用），这里只做形状转换。

import { buildTimeline, type AnsweredAsk, type AskRequest, type TimelineEntry } from '@diy-agent/chat-core';
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
    kind: 'chat' | 'notice' | 'error' | 'typing';
    author?: TimelineEntry['author'];
    deliveries?: DeliveryChip[];
    /** 当前房间：头像按项目/任务取图标 */
    roomId?: string;
    /** typing 占位的开始时间（毫秒）：界面据此显示"执行中 Ns" */
    startedAt?: number;
    /** 本轮还在跑但当前没有流式内容：在消息末尾显示"执行中 Ns" */
    waiting?: boolean;
    /** 这一轮的结局（`turn.end` 给的）：页脚那行"怎么停的"，completed 不显示 */
    endReason?: TimelineEntry['endReason'];
}

const completeStatus: ThreadMessageLike['status'] = { type: 'complete', reason: 'stop' };
const runningStatus: ThreadMessageLike['status'] = { type: 'running' };

type Part =
    NonNullable<ThreadMessageLike['content']> extends string
        ? never
        : Exclude<ThreadMessageLike['content'], string>[number];

function partsOf(entry: TimelineEntry): Part[] {
    return entry.parts.map((part) => {
        if (part.kind === 'text') return { type: 'text', text: part.text };
        // 失败是回复的一部分，assistant-ui 这边没有错误 part 类型：降级成一行文本，
        // 至少位置是对的（在它发生的地方），不会被推到整条回复之后。
        if (part.kind === 'error') return { type: 'text', text: `⚠ ${part.message}` };
        if (part.kind === 'ask')
            return {
                type: 'data-ask',
                data: {
                    request: part.request,
                    // 已有结局的卡片要带上答案，界面据此冻结成「已选」状态
                    ...(part.answer === undefined && part.cancelled !== true && part.expired !== true
                        ? {}
                        : {
                              resolved: {
                                  ...(part.answer === undefined ? {} : { answer: part.answer }),
                                  ...(part.cancelled === true ? { cancelled: true } : {}),
                                  ...(part.expired === true ? { expired: true } : {}),
                                  ...(part.reason === undefined ? {} : { reason: part.reason }),
                              },
                          }),
                },
            } as Part;
        return {
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            args: (part.args ?? {}) as never,
            result: part.result,
            isError: part.state === 'error',
        };
    });
}

export function toThreadMessages(
    items: Item[],
    deliveries: readonly Delivery[] = [],
    bots: Record<string, Bot> = {},
    roomId?: string,
    speaking: readonly string[] = [],
    asks: readonly AskRequest[] = [],
    answered: readonly AnsweredAsk[] = [],
    endReasons: Record<string, TimelineEntry['endReason'] & {}> = {},
): ThreadMessageLike[] {
    return buildTimeline(items, deliveries, bots, { speaking, asks, answered, endReasons }).map((entry) => {
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
                content: [
                    { type: 'text', text: entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('') },
                ],
                metadata: { custom },
            };
        }

        if (entry.kind === 'typing') {
            // 空内容 + running：模板的 GroupedParts indicator 会渲染"●"
            return {
                id: entry.key,
                createdAt,
                role: 'assistant',
                content: [],
                status: runningStatus,
                metadata: {
                    custom: {
                        kind: 'typing',
                        author: entry.author,
                        startedAt: entry.at,
                        ...(roomId === undefined ? {} : { roomId }),
                    } satisfies CustomMeta,
                },
            };
        }

        if (entry.kind === 'notice' || entry.kind === 'error') {
            return {
                id: entry.key,
                createdAt,
                role: 'assistant',
                content: partsOf(entry),
                status: completeStatus,
                metadata: {
                    custom: {
                        kind: entry.kind,
                        // 失败要能看出是"谁的回复失败"（notice 没有作者）
                        ...(entry.author === undefined ? {} : { author: entry.author }),
                        ...(roomId === undefined ? {} : { roomId }),
                    } satisfies CustomMeta,
                },
            };
        }

        return {
            id: entry.key,
            createdAt,
            role: 'assistant',
            content: partsOf(entry),
            status,
            metadata: {
                custom: {
                    kind: 'chat',
                    author: entry.author,
                    ...(roomId === undefined ? {} : { roomId }),
                    ...(entry.waiting === true ? { waiting: true } : {}),
                    ...(entry.waiting === true ? { startedAt: entry.at } : {}),
                    ...(entry.endReason === undefined ? {} : { endReason: entry.endReason }),
                } satisfies CustomMeta,
            },
        };
    });
}
