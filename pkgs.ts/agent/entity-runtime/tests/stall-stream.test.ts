// stall-stream.test.ts —— **上游流挂住**时这一轮必须有个结局（而不是永远停在 for-await）。
//
// 真实事故（2026-11-23）：`job wait` 之后的那次模型调用在流中途静默挂住，于是 turn 不收尾、
// `speaking` 不清空、投递卡在 delivering —— 界面既不显示在跑、也没有停止按钮，30 分钟没人
// 知道发生了什么。这里用一个「永不 close 的 ReadableStream」复现它，断言：
//   ① 首包不来 ⇒ 按期判停摆，产出 `run.failed`（不是一直挂着）；
//   ② 流到一半停住 ⇒ 同样判停摆，且已经到手的文本不丢；
//   ③ 正常回复不被误杀（同一套判据下照常 `run.completed`）。

import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';

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

async function collect(model: MockLanguageModelV3, stallTimeouts: { firstMs: number; idleMs: number; toolMs: number }) {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
        bot,
        modelKey: 'stub/model',
        model,
        messages: [{ role: 'user', content: '开始' }],
        signal: new AbortController().signal,
        stallTimeouts,
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
