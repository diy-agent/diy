// 切模型后**当前轮的下一次 LLM 请求**就换模型（不是等下一轮）。
//
// 用户 2026-11-27 的要求：「切换模型后下一次调用 llm 立即生效，而不是下一个轮次」。
// 实现：prepareStep 每步读一次 `getModelKey`，变了就返回 `{ model: resolve(next) }`。
// 断言口径 = 上游实际收到的模型（`doStreamCalls[i]` 来自哪个 Mock 实例）。

import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from '@ai-sdk/provider';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runAgent } from '../src/agent';
import type { Bot } from '../src/types';

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
            },
        }),
    };
}

const textReply = (text: string) =>
    stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ]);

const toolCallReply = (callId: string) =>
    stream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: callId, toolName: 'echo' },
        { type: 'tool-input-delta', id: callId, delta: '{}' },
        { type: 'tool-input-end', id: callId },
        { type: 'tool-call', toolCallId: callId, toolName: 'echo', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
    ]);

const bot: Bot = {
    id: 'bot-1',
    name: 'bot',
    color: '#000000',
    persona: '测试',
    homeRoomId: 'room-1',
    modelKey: 'stub/model-a',
};

const tools = {
    echo: tool({
        description: 'echo',
        inputSchema: z.object({}),
        execute: async () => 'ok',
    }),
};

describe('runAgent：切模型后下一次 LLM 请求就换', () => {
    it('第 1 步 tool call 后切模型 → 第 2 步用新模型实例', async () => {
        const modelA = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model-a',
            doStream: () => Promise.resolve(toolCallReply('c1')),
        });
        const modelB = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model-b',
            doStream: () => Promise.resolve(textReply('done')),
        });

        // 第 1 步之前读旧键，第 2 步之前读新键 —— 模拟「用户在第 1 步跑的时候切了模型」
        let reads = 0;
        for await (const _event of runAgent({
            bot,
            modelKey: 'stub/model-a',
            resolveModel: (modelKey) => (modelKey === 'stub/model-a' ? modelA : modelB),
            getModelKey: () => (reads++ === 0 ? 'stub/model-a' : 'stub/model-b'),
            messages: [{ role: 'user', content: '开始' }],
            signal: new AbortController().signal,
            tools,
            maxSteps: 3,
        })) {
            /* 吃完 */
        }

        // 第 1 步在 A 上，第 2 步在 B 上 —— 无需等下一轮
        expect(modelA.doStreamCalls).toHaveLength(1);
        expect(modelB.doStreamCalls).toHaveLength(1);
    });
});
