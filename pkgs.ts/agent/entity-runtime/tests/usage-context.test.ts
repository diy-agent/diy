// usage-context.test.ts —— 两个用量口径必须分开：整轮之和（计费）vs 最后一步（压缩水位）
//
// 为什么要有：`result.usage` / `result.totalUsage` 都是**各步之和**（AI SDK 官方注释），
// 一步就把整份上下文重发一遍 —— 40 步的正常轮次会报出 850 万 token。把它当上下文水位，
// 压缩判据（窗口 − max(10%,16k)）就会在真实上下文只有 20 万时误触发
// （2026-11-28 实证：turn=102 刚启动就压了一次，还为此花了 18 秒摘要）。
//
// 这里用 MockLanguageModelV3 跑一个两步循环，锁三件事：
//   ① `onUsage` 拿到各步之和（计费口径）；
//   ② `onContextUsage` 只拿到最后一步（水位口径）；
//   ③ 两者不共用同一个回调（共用就必然有一边是错的）。

import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from '@ai-sdk/provider';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runAgent } from '../src/agent';
import type { Bot } from '../src/types';

function usage(input: number, output: number): LanguageModelV3Usage {
    return {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
    };
}

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

/** 第 1 步：调工具（上下文 100 万？不 —— 这里用 100） */
const toolCallReply = (callId: string) =>
    stream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: callId, toolName: 'echo' },
        { type: 'tool-input-delta', id: callId, delta: '{}' },
        { type: 'tool-input-end', id: callId },
        { type: 'tool-call', toolCallId: callId, toolName: 'echo', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(100, 10) },
    ]);

/** 第 2 步：说完（这一步的输入才是「当前上下文多大」） */
const textReply = () =>
    stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '说完了' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(200, 20) },
    ]);

const bot: Bot = {
    id: 'bot-1',
    name: 'bot',
    color: '#000000',
    persona: '',
    homeRoomId: 'room-1',
    modelKey: 'stub/model',
};

const tools = {
    echo: tool({ description: 'echo', inputSchema: z.object({}), execute: async () => 'ok' }),
};

describe('runAgent：用量两个口径', () => {
    it('onUsage = 各步之和；onContextUsage = 最后一步', async () => {
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => {
                call += 1;
                return Promise.resolve(call === 1 ? toolCallReply('c1') : textReply());
            },
        });
        let total: { inputTokens: number; outputTokens: number } | undefined;
        let context: { inputTokens: number; outputTokens: number } | undefined;

        for await (const _event of runAgent({
            bot,
            modelKey: 'stub/model',
            model,
            messages: [{ role: 'user', content: '开始' }],
            signal: new AbortController().signal,
            tools,
            maxSteps: 5,
            onUsage: (value) => {
                total = value;
            },
            onContextUsage: (value) => {
                context = value;
            },
        })) {
            // 只看收尾回调
        }

        expect(total).toEqual({ inputTokens: 300, outputTokens: 30 });
        expect(context).toEqual({ inputTokens: 200, outputTokens: 20 });
    });
});
