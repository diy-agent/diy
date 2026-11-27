// waterline.test.ts —— 轮内水位在**真跑出来的循环里**生效（不是只有单元函数对）。
//
// 压缩只在轮首看一次；这里锁的是「第 2 步开始，每步都看」这条接线：
// 断言口径 = 上游实际收到的 prompt（`model.doStreamCalls[i].prompt`），
// 与 step-delta.test.ts 同一套 MockLanguageModelV3 手法。

import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
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

const textReply = () =>
    stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'done' },
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
    echo: tool({ description: 'echo', inputSchema: z.object({}), execute: async () => 'ok' }),
};

/** 历史里已经躺着一条 30 万字符的工具输出（≈7.5 万 token，按 4 字符/token） */
const HUGE = 'x'.repeat(300_000);
const messages: ModelMessage[] = [
    { role: 'user', content: '开始' },
    {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'echo', input: {} }],
    },
    {
        role: 'tool',
        content: [
            { type: 'tool-result', toolCallId: 'old', toolName: 'echo', output: { type: 'text', value: HUGE } },
        ],
    },
];

describe('runAgent：轮内水位', () => {
    it('第 2 步起把超量的工具输出折掉；第 1 步原样发（那时还没有本轮增长）', async () => {
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => Promise.resolve(call++ === 0 ? toolCallReply('c1') : textReply()),
        });

        for await (const _event of runAgent({
            bot,
            modelKey: 'stub/model',
            model,
            messages,
            signal: new AbortController().signal,
            tools,
            // 窗口 10 万 ⇒ 触发线 7 万，历史 7.5 万已经在线上了
            windowTokens: 100_000,
        })) {
            /* 吃完 */
        }

        expect(model.doStreamCalls.length).toBe(2);
        expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain('已折叠');
        expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('已折叠');
        // 折叠只在这一步的请求里：原 messages 一个字节都没动（下一轮 / 界面照旧）
        expect((messages[2] as { content: Array<{ output: { value: string } }> }).content[0]!.output.value).toBe(HUGE);
    });

    it('窗口未知 ⇒ 不折（不猜窗口）', async () => {
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => Promise.resolve(call++ === 0 ? toolCallReply('c1') : textReply()),
        });

        for await (const _event of runAgent({
            bot,
            modelKey: 'stub/model',
            model,
            messages,
            signal: new AbortController().signal,
            tools,
        })) {
            /* 吃完 */
        }

        expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain('已折叠');
    });
});
