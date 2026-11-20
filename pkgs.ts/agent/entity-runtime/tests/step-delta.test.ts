// 变量增量属于**模型步**，不属于「谁触发了这一轮」：prepareStep 每一步取一次。
//
// 用 MockLanguageModelV3 跑真实的 streamText 循环：第一模型步发 tool call，第二步收尾。
// 断言口径 = 上游实际收到的 prompt（`model.doStreamCalls[i].prompt`），不是内部函数。

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
    modelKey: 'stub/model',
};

const tools = {
    echo: tool({
        description: 'echo',
        inputSchema: z.object({}),
        execute: async () => 'ok',
    }),
};

describe('runAgent：每步取一次变量增量', () => {
    it('首个模型步与工具后的下一步都带各自的增量；每步成功收尾才 commit', async () => {
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => {
                const reply = call === 0 ? toolCallReply('c1') : textReply('done');
                call += 1;
                return Promise.resolve(reply);
            },
        });

        const deltas = ['vars:\n  task.body: 第一版', 'vars:\n  task.body: 第二版'];
        let deltaAt = 0;
        let commits = 0;

        for await (const _event of runAgent({
            bot,
            modelKey: 'stub/model',
            model,
            messages: [{ role: 'user', content: '开始' }],
            signal: new AbortController().signal,
            tools,
            takeDelta: () => deltas[Math.min(deltaAt++, deltas.length - 1)]!,
            commitDelta: () => {
                commits += 1;
            },
        })) {
            /* 吃完 */
        }

        expect(model.doStreamCalls.length).toBe(2);
        const first = model.doStreamCalls[0]!.prompt;
        const second = model.doStreamCalls[1]!.prompt;
        expect(JSON.stringify(first.at(-1))).toContain('第一版');
        expect(JSON.stringify(second.at(-1))).toContain('第二版');
        // 两个模型步各 commit 一次（失败/重试不会走到这里）
        expect(commits).toBe(2);
    });

    it('增量为空 ⇒ 不追加消息（前缀缓存不动）', async () => {
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => Promise.resolve(textReply('done')),
        });
        const before = model.doStreamCalls.length;
        for await (const _event of runAgent({
            bot,
            modelKey: 'stub/model',
            model,
            messages: [{ role: 'user', content: '开始' }],
            signal: new AbortController().signal,
            takeDelta: () => '',
            commitDelta: () => {},
        })) {
            /* 吃完 */
        }
        const call = model.doStreamCalls[before]!;
        // system + 原来那条 user；没有额外的空信封
        expect(call.prompt).toHaveLength(2);
    });
});
