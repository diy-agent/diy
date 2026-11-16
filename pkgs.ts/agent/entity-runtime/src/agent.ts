// agent.ts —— 一次 bot 运行：streamText → AgentEvent（文本 / 推理 / 工具 / 结束）。
//
// 除了"给 UI 看的事件流"，这里还负责把**这一轮真正喂进模型的完整消息**回传给调用方
// （assistant 带 tool call / tool result / reasoning 都在里面），session 用它维护自己的原生对话。

import { streamText, tool, type Experimental_Steering, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';

import { friendlyError } from './errors';
import { maxOutputTokensOf, modelOf } from './providers';
import { clipModelMessage } from './tools/clip';
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
    /** 房间装配的工具；不传 = 只用内置的 get_time（测试 / 无目录房间） */
    tools?: ToolSet;
    /** 系统提示里关于工具的一句话（房间知道自己给了哪些能力） */
    toolsHint?: string;
    /**
     * 每一步结束时回传"本步新增的消息"，按 step 顺序拼接就是这一轮的完整增量：
     *   本步被插入的 steering 用户消息 + 模型产出的 assistant / tool 消息。
     */
    onStepTranscript?: (messages: ModelMessage[]) => void;
    /** 本轮真实用量（token），用于校准压缩预算 */
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
    /**
     * 本轮输出上限（`max_tokens`）。不传 = 按 modelKey 推（provider 硬上限 / 场景缺省）。
     * **不要省成 undefined 再指望服务端缺省**：那会让长回答被静默截断（见 `maxOutputTokensOf`）。
     */
    maxOutputTokens?: number;
}

const defaultTools = {
    get_time: tool({
        description: '获取当前时间（ISO 字符串）',
        inputSchema: z.object({ timezone: z.string().optional().describe('IANA 时区，例如 Asia/Shanghai') }),
        execute: async ({ timezone }) => {
            const now = new Date();
            const text =
                timezone === undefined ? now.toISOString() : now.toLocaleString('zh-CN', { timeZone: timezone });
            return { now: text, timezone: timezone ?? 'UTC' };
        },
    }),
};

export async function* runAgent(options: RunOptions): AsyncIterable<AgentEvent> {
    let seq = 0;
    const turnId = options.turnId ?? `turn-${Date.now().toString(36)}`;
    const messageId = `msg-${Date.now().toString(36)}`;

    yield { seq: ++seq, type: 'run.started', turnId, messageId };

    const maxOutputTokens = maxOutputTokensOf(options.modelKey, options.maxOutputTokens);

    const result = streamText({
        model: modelOf(options.modelKey),
        abortSignal: options.signal,
        maxOutputTokens,
        instructions: [
            `你是「${options.bot.name}」，这个实体的专属 bot。`,
            options.bot.persona,
            options.toolsHint ?? '回答简洁；需要时间时调用 get_time 工具。',
        ].join('\n'),
        messages: options.messages,
        tools: options.tools ?? defaultTools,
        // 不设步数上限：模型想调多少次工具就调多少次（AI SDK 缺省是 1 步，必须显式覆盖）。
        // 唯一的刹车是用户点停止（abort）。
        stopWhen: () => false,
        // 连接超时这类瞬时错误自动重试；不可重试的错误 SDK 自己会跳过
        maxRetries: 2,
        ...(options.steering === undefined ? {} : { experimental_steering: options.steering }),
        onStepFinish: (step) => {
            if (options.onStepTranscript === undefined) return;
            // 工具输出只裁"喂给模型"的那份；UI 的 tool-result 事件仍然是完整输出
            options.onStepTranscript([
                ...(step.experimental_steeringMessages ?? []),
                ...step.response.messages.map((message) => clipModelMessage(message)),
            ]);
        },
    });

    /** 收尾事实：截断 / 工具悬空 / 正常说完，全靠这三个值分辨（见 docs 里的 `##429`） */
    let finishReason = 'unknown';
    let steps = 0;

    try {
        for await (const part of result.stream) {
            switch (part.type) {
                case 'finish-step':
                    steps += 1;
                    break;
                case 'finish':
                    // 这是**唯一**能看出「被输出上限砍断」的地方：SDK 在 length 时只是结束循环，
                    // 不发 error part。以前这里落进 default，于是截断在数据里长得和成功一样。
                    finishReason = part.finishReason ?? 'unknown';
                    break;
                case 'abort':
                    finishReason = 'aborted';
                    break;
                case 'text-delta':
                    yield { seq: ++seq, type: 'text.delta', messageId, delta: part.text };
                    break;
                case 'reasoning-delta':
                    yield { seq: ++seq, type: 'reasoning.delta', messageId, delta: part.text };
                    break;
                case 'tool-call':
                    yield {
                        seq: ++seq,
                        type: 'tool.started',
                        turnId,
                        toolCallId: part.toolCallId,
                        name: part.toolName,
                        args: part.input,
                    };
                    break;
                case 'tool-result':
                    yield {
                        seq: ++seq,
                        type: 'tool.completed',
                        turnId,
                        toolCallId: part.toolCallId,
                        name: part.toolName,
                        result: part.output,
                    };
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
                    yield {
                        seq: ++seq,
                        type: 'run.failed',
                        turnId,
                        message: friendlyError((part as { error?: unknown }).error),
                    };
                    return;
                default:
                    break;
            }
        }
    } catch (error) {
        yield { seq: ++seq, type: 'run.failed', turnId, message: friendlyError(error) };
        return;
    }

    try {
        const usage = await result.totalUsage;
        options.onUsage?.({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
    } catch {
        // 用量拿不到不影响这一轮
    }

    yield { seq: ++seq, type: 'run.finished', turnId, finishReason, steps, maxOutputTokens };
    yield { seq: ++seq, type: 'message.completed', messageId };
    yield { seq: ++seq, type: 'run.completed', turnId };
}
