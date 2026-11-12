// agent.ts —— 一次 bot 运行：streamText → AgentEvent（文本 / 推理 / 工具 / 结束）。

import { isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';

import { modelOf } from './providers';
import type { AgentEvent, Bot } from './types';

export interface RunOptions {
    bot: Bot;
    modelKey: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    signal: AbortSignal;
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
    const turnId = `turn-${Date.now().toString(36)}`;
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
        stopWhen: isStepCount(4),
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
                    yield { seq: ++seq, type: 'tool.started', toolCallId: part.toolCallId, name: part.toolName, args: part.input };
                    break;
                case 'tool-result':
                    yield { seq: ++seq, type: 'tool.completed', toolCallId: part.toolCallId, name: part.toolName, result: part.output };
                    break;
                case 'tool-error':
                    yield {
                        seq: ++seq,
                        type: 'tool.completed',
                        toolCallId: (part as { toolCallId: string }).toolCallId,
                        name: (part as { toolName?: string }).toolName ?? 'tool',
                        error: String((part as { error?: unknown }).error ?? 'tool error'),
                    };
                    break;
                case 'error':
                    yield { seq: ++seq, type: 'run.failed', turnId, message: String((part as { error?: unknown }).error ?? 'stream error') };
                    break;
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
