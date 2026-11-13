// agent.ts —— 一次 bot 运行：streamText → AgentEvent（文本 / 推理 / 工具 / 结束）。

import { isStepCount, streamText, tool, type Experimental_Steering } from 'ai';
import { z } from 'zod';

import { modelOf } from './providers';
import type { AgentEvent, Bot } from './types';

export interface RunOptions {
    bot: Bot;
    modelKey: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    signal: AbortSignal;
    /** 由调用方分配（同 turn 的多个 bot 共享 turnId） */
    turnId?: string;
    /** next-step 插入点：SDK 在 step 边界把消息作为独立 user 消息追加 */
    steering?: Experimental_Steering;
}

const tools = {
    get_time: tool({
        description: '获取当前时间（ISO 字符串）',
        inputSchema: z.object({ timezone: z.string().optional().describe('IANA 时区，例如 Asia/Shanghai') }),
        execute: async ({ timezone }) => {
            const now = new Date();
            const text = timezone === undefined ? now.toISOString() : now.toLocaleString('zh-CN', { timeZone: timezone });
            return { now: text, timezone: timezone ?? 'UTC' };
        },
    }),
};

export async function* runAgent(options: RunOptions): AsyncIterable<AgentEvent> {
    let seq = 0;
    const turnId = options.turnId ?? `turn-${Date.now().toString(36)}`;
    const messageId = `msg-${Date.now().toString(36)}`;

    yield { seq: ++seq, type: 'run.started', turnId, messageId };

    const result = streamText({
        model: modelOf(options.modelKey),
        abortSignal: options.signal,
        instructions: [
            `你是「${options.bot.name}」，这个实体的专属 bot。`,
            options.bot.persona,
            '回答简洁；需要时间时调用 get_time 工具。',
        ].join('\n'),
        messages: options.history,
        tools,
        stopWhen: isStepCount(6),
        maxRetries: 0,
        ...(options.steering === undefined ? {} : { experimental_steering: options.steering }),
    });

    try {
        for await (const part of result.stream) {
            switch (part.type) {
                case 'text-delta':
                    yield { seq: ++seq, type: 'text.delta', messageId, delta: part.text };
                    break;
                case 'reasoning-delta':
                    yield { seq: ++seq, type: 'reasoning.delta', messageId, delta: part.text };
                    break;
                case 'tool-call':
                    yield { seq: ++seq, type: 'tool.started', turnId, toolCallId: part.toolCallId, name: part.toolName, args: part.input };
                    break;
                case 'tool-result':
                    yield { seq: ++seq, type: 'tool.completed', turnId, toolCallId: part.toolCallId, name: part.toolName, result: part.output };
                    break;
                case 'tool-error':
                    yield {
                        seq: ++seq,
                        type: 'tool.completed',
                        turnId,
                        toolCallId: (part as { toolCallId: string }).toolCallId,
                        name: (part as { toolName?: string }).toolName ?? 'tool',
                        error: String((part as { error?: unknown }).error ?? 'tool error'),
                    };
                    break;
                case 'error':
                    yield { seq: ++seq, type: 'run.failed', turnId, message: String((part as { error?: unknown }).error ?? 'stream error') };
                    return;
                default:
                    break;
            }
        }
    } catch (error) {
        yield { seq: ++seq, type: 'run.failed', turnId, message: error instanceof Error ? error.message : String(error) };
        return;
    }

    yield { seq: ++seq, type: 'message.completed', messageId };
    yield { seq: ++seq, type: 'run.completed', turnId };
}
