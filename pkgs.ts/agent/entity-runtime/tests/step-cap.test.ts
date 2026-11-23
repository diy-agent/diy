// step-cap.test.ts —— 步数刹车：一轮的工具循环必须有上限，且「撞上限」要能被认出来。
//
// 为什么要有：`stopWhen` 缺省不限步数时，唯一刹车是用户点停止。手动对话没问题，
// 一旦接上后台作业 / 远程 / 多端，一次工具循环就能跑到天亮（diy1 的缺省是 200）。
//
// 这里锁三件事（用 MockLanguageModelV3 跑真实 streamText 循环，断言的是上游实际调用次数）：
//   1. `maxSteps` 真的截住了循环（模型想继续也调不动了）；
//   2. 撞上限且「上游还想继续调工具」⇒ finishReason 改写成 `max-steps`（不是伪装成完成）；
//   3. 最后一步是自然说完（finish=stop）⇒ **不改写**，免得把正常收尾降级成未完成。

import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from '@ai-sdk/provider';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_MAX_STEPS, runAgent } from '../src/agent';
import type { AgentEvent, Bot } from '../src/types';

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
        { type: 'text-delta', id: 't', delta: '说完了' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ]);

/** 一直想调工具：模拟「干不完的活」 */
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
    persona: '',
    homeRoomId: 'room-1',
    modelKey: 'stub/model',
};

const tools = {
    echo: tool({ description: 'echo', inputSchema: z.object({}), execute: async () => 'ok' }),
};

async function runWith(replies: Array<() => LanguageModelV3StreamResult>, maxSteps: number) {
    let call = 0;
    const model = new MockLanguageModelV3({
        provider: 'stub',
        modelId: 'model',
        doStream: () => {
            const reply = replies[Math.min(call, replies.length - 1)]!;
            call += 1;
            return Promise.resolve(reply());
        },
    });
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
        bot,
        modelKey: 'stub/model',
        model,
        messages: [{ role: 'user', content: '开始' }],
        signal: new AbortController().signal,
        tools,
        maxSteps,
    })) {
        events.push(event);
    }
    const finished = events.find((event) => event.type === 'run.finished');
    return { finished, calls: model.doStreamCalls.length };
}

describe('runAgent：步数刹车', () => {
    it('缺省上限是 200（与 diy1 同值，不是「不限」）', () => {
        expect(DEFAULT_MAX_STEPS).toBe(200);
    });

    it('一直想调工具 ⇒ 停在上限，收尾原因改写成 max-steps', async () => {
        const { finished, calls } = await runWith([() => toolCallReply('c')], 3);
        expect(calls).toBe(3);
        expect(finished?.type === 'run.finished' && finished.finishReason).toBe('max-steps');
        expect(finished?.type === 'run.finished' && finished.steps).toBe(3);
        expect(finished?.type === 'run.finished' && finished.maxSteps).toBe(3);
    });

    it('最后一步自然说完 ⇒ 不改写（finish=stop 仍是 stop）', async () => {
        // 第 1 步调工具、第 2 步说完；上限正好 2 步 —— 撞到上限但没被掐停
        const { finished, calls } = await runWith([() => toolCallReply('c'), () => textReply()], 2);
        expect(calls).toBe(2);
        expect(finished?.type === 'run.finished' && finished.finishReason).toBe('stop');
    });
});
