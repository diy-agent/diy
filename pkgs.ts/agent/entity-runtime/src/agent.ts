// agent.ts —— 一次 bot 运行：streamText → AgentEvent（文本 / 推理 / 工具 / 结束）。
//
// 除了"给 UI 看的事件流"，这里还负责把**这一轮真正喂进模型的完整消息**回传给调用方
// （assistant 带 tool call / tool result / reasoning 都在里面），session 用它维护自己的原生对话。

import { isStepCount, streamText, tool, type Experimental_Steering, type ModelMessage } from 'ai';
import { z } from 'zod';

import { modelOf } from './providers';
import type { AgentEvent, Bot } from './types';

export interface RunOptions {
    bot: Bot;
    modelKey: string;
    /** 这一轮开始时的完整上下文（session 自己拼：公共条目 + 自己的私有过程） */
    messages: ModelMessage[];
    signal: AbortSignal;
    /** 由调用方分配（同 turn 的多个 bot 共享 turnId） */
    turnId?: string;
    /** next-step 插入点：SDK 在 step 边界把消息作为独立 user 消息追加 */
    steering?: Experimental_Steering;
    /**
     * 每一步结束时回传"本步新增的消息"，按 step 顺序拼接就是这一轮的完整增量：
     *   本步被插入的 steering 用户消息 + 模型产出的 assistant / tool 消息。
     */
    onStepTranscript?: (messages: ModelMessage[]) => void;
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
        messages: options.messages,
        tools,
        stopWhen: isStepCount(6),
        maxRetries: 0,
        ...(options.steering === undefined ? {} : { experimental_steering: options.steering }),
        onStepFinish: (step) => {
            if (options.onStepTranscript === undefined) return;
            options.onStepTranscript([...(step.experimental_steeringMessages ?? []), ...step.response.messages]);
        },
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
