// stall-stream.test.ts —— **上游流挂住**时这一轮必须有个结局（而不是永远停在 for-await）。
//
// 真实事故（2026-11-23）：`job wait` 之后的那次模型调用在流中途静默挂住，于是 turn 不收尾、
// `speaking` 不清空、投递卡在 delivering —— 界面既不显示在跑、也没有停止按钮，30 分钟没人
// 知道发生了什么。这里用一个「永不 close 的 ReadableStream」复现它，断言：
//   ① 首包不来 ⇒ 按期判停摆，产出 `run.failed`（不是一直挂着）；
//   ② 流到一半停住 ⇒ 同样判停摆，且已经到手的文本不丢；
//   ③ 正常回复不被误杀（同一套判据下照常 `run.completed`）。

import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from '@ai-sdk/provider';
import { tool, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runAgent } from '../src/agent';
import type { AgentEvent, Bot } from '../src/types';

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const bot: Bot = {
    id: 'bot-1',
    name: 'bot',
    color: '#000000',
    persona: '测试',
    homeRoomId: 'room-1',
    modelKey: 'stub/model',
};

/** 永不 close 的流：可以先吐一点东西，然后彻底安静（= 网关静默挂住） */
function stalledStream(prefix: LanguageModelV3StreamPart[] = []): LanguageModelV3StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                for (const part of prefix) controller.enqueue(part);
                // 不 close、不再 enqueue：模拟上游不再发数据
            },
        }),
    };
}

function completedStream(text: string): LanguageModelV3StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 't' });
                controller.enqueue({ type: 'text-delta', id: 't', delta: text });
                controller.enqueue({ type: 'text-end', id: 't' });
                controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
                controller.close();
            },
        }),
    };
}

/** 正常 close 的流：给什么 parts 就吐什么（与 `stalledStream` 相反，它靠不 close 复现挂住） */
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

/** 第一步：调一个工具然后收住 —— 流正常 close ⇒ SDK 去执行工具、再开第二步 */
const toolCallStream = (toolName: string): LanguageModelV3StreamResult =>
    stream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'tc1', toolName },
        { type: 'tool-input-delta', id: 'tc1', delta: '{}' },
        { type: 'tool-input-end', id: 'tc1' },
        { type: 'tool-call', toolCallId: 'tc1', toolName, input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
    ]);

async function collect(
    model: MockLanguageModelV3,
    stallTimeouts: { firstMs: number; idleMs: number; toolMs: number },
    extra: { tools?: ToolSet; unboundedTools?: string[] } = {},
) {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
        bot,
        modelKey: 'stub/model',
        model,
        messages: [{ role: 'user', content: '开始' }],
        signal: new AbortController().signal,
        stallTimeouts,
        ...(extra.tools === undefined ? {} : { tools: extra.tools }),
        ...(extra.unboundedTools === undefined ? {} : { unboundedTools: extra.unboundedTools }),
    })) {
        events.push(event);
    }
    return events;
}

const failureOf = (events: AgentEvent[]): string | undefined =>
    events.find((event) => event.type === 'run.failed')?.message;

describe('上游停摆', () => {
    it('首包一直不来：判停摆并给出 run.failed（不挂死）', async () => {
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => Promise.resolve(stalledStream()),
        });
        const events = await collect(model, { firstMs: 20, idleMs: 20, toolMs: 0 });
        expect(failureOf(events)).toContain('上游停摆');
        // 停摆不是正常收尾：不许出现 run.finished / run.completed
        expect(events.some((event) => event.type === 'run.finished')).toBe(false);
        expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    });

    it('流到一半停住：判停摆，已经吐出来的文本不丢', async () => {
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () =>
                Promise.resolve(
                    stalledStream([
                        { type: 'text-start', id: 't' },
                        { type: 'text-delta', id: 't', delta: '说到一半' },
                    ]),
                ),
        });
        const events = await collect(model, { firstMs: 500, idleMs: 20, toolMs: 0 });
        expect(events.filter((event) => event.type === 'text.delta').map((event) => event.message)).toBeDefined();
        expect(failureOf(events)).toContain('上游停摆');
        expect(failureOf(events)).toContain('上一个数据块之后');
    });

    it('正常回复不被误杀', async () => {
        const model = new MockLanguageModelV3({
            provider: 'stub',
            modelId: 'model',
            doStream: () => Promise.resolve(completedStream('说完了')),
        });
        const events = await collect(model, { firstMs: 500, idleMs: 500, toolMs: 0 });
        expect(failureOf(events)).toBeUndefined();
        expect(events.some((event) => event.type === 'run.completed')).toBe(true);
    });
});

// ##560：`toolStart(part.toolName)` 这段接线 —— 名字要一路带到收尾，否则模型和界面
// 都只知道「有工具卡住了」，不知道是哪个、也就无从去改那一步。同时锁住豁免名单的语义：
// 名单内的（`ask`）跑多久都不该被 `toolMs` 掐。
describe('工具时段接线（toolName 从 tool-call 一路带到收尾）', () => {
    /** 慢工具：120ms > 下面的 `toolMs: 30ms`，够区分「掐了 / 没掐」 */
    const slowTool = () =>
        tool({
            description: '等 120ms 再返回',
            inputSchema: z.object({}),
            execute: async () => {
                await new Promise((resolve) => setTimeout(resolve, 120));
                return 'ok';
            },
        });

    /** 第一步调 `toolName`、第二步正常说完（步序由 `doStream` 调用次数推进） */
    async function runTwoSteps(
        toolName: string,
        stallTimeouts: { firstMs: number; idleMs: number; toolMs: number },
        unboundedTools: string[],
    ) {
        const replies = [() => toolCallStream(toolName), () => completedStream('说完了')];
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
        const events = await collect(model, stallTimeouts, {
            tools: { [toolName]: slowTool() },
            unboundedTools,
        });
        return { events, calls: model.doStreamCalls.length };
    }

    const failedOf = (events: AgentEvent[]): Extract<AgentEvent, { type: 'run.failed' }> | undefined =>
        events.find((event): event is Extract<AgentEvent, { type: 'run.failed' }> => event.type === 'run.failed');

    it('名单外的工具跑满 toolMs ⇒ 判停摆，工具名报到收尾（接线断了这里就是 undefined）', async () => {
        // 名单给空：bash 必须受 toolMs 约束，别让豁免名单把断言干扰掉
        const { events, calls } = await runTwoSteps('bash', { firstMs: 5_000, idleMs: 5_000, toolMs: 30 }, []);

        const failed = failedOf(events);
        expect(failed).toBeDefined();
        expect(failed?.stall?.phase).toBe('tool');
        // ↓ 这两条是接线的判据：`toolStart()` 不收名字 ⇒ toolName 缺失、文案变成「（未知）」
        expect(failed?.stall?.toolName).toBe('bash');
        expect(failed?.message).toContain('bash');
        // 事件侧也带了名字（`tool.started`），模型据此知道是哪一步卡住
        expect(events.some((event) => event.type === 'tool.started' && event.name === 'bash')).toBe(true);
        expect(calls).toBe(1); // 30ms 就被掐了，不该开第二步
    });

    it('豁免名单内的工具（ask）不受 toolMs 约束：跑得比 toolMs 久也不被掐', async () => {
        // toolMs=30 而工具要跑 120ms：没豁免的话 30ms 就该有 run.failed
        const { events, calls } = await runTwoSteps('ask', { firstMs: 5_000, idleMs: 5_000, toolMs: 30 }, ['ask']);

        expect(events.some((event) => event.type === 'run.failed')).toBe(false);
        expect(events.some((event) => event.type === 'run.completed')).toBe(true);
        expect(calls).toBe(2); // 工具跑完还回来了，第二步正常收尾
    });
});
