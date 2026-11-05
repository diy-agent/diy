// user-abort.test.ts — **真实用户中断**（C3）
//
// 之前 `abort.gen.ts` 那个 fixture 模拟的是「上游中途断开」（有 start 无 finish），
// 而真实用户点「停止」走的是另一条路：`options.signal` 被 abort ⇒ ai-sdk 抛 AbortError
// ⇒ chatStream 的 catch 分类。**那条路之前零覆盖**。
//
// 为什么不能再用 fixture：录制只能录到「上游给了什么」，录不到「我们这边中途喊停」。
// 所以要自己造一个**慢速流**（每块之间有延迟），在中间 abort。

import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { chatStream } from '../src/openai.js';
import type { ChatMessage, SessionDelta } from '@diy-agent/session';

const msg = (text: string): ChatMessage => ({ role: 'user', text });
const wire = { provider: 'test', model: 'test-model', baseUrl: 'https://example.test/v1' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 慢速模型：先吐一块文本，sleep 之后再看 abortSignal。
 *
 * 为什么在 `start` 里判而不是 `pull`：ReadableStream 的 `pull` 由消费者节奏驱动，
 * 而 ai-sdk 的消费节奏不受我们控制 —— `start` 里自己 await 才能稳定复现「中途停下」。
 */
function slowModel(blockMs: number, blocks: number) {
    return new MockLanguageModelV3({
        doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
            stream: new ReadableStream({
                async start(controller) {
                    controller.enqueue({ type: 'stream-start', warnings: [] });
                    controller.enqueue({ type: 'text-start', id: 't1' });
                    for (let i = 0; i < blocks; i++) {
                        if (abortSignal?.aborted === true) {
                            controller.error(new DOMException('This operation was aborted', 'AbortError'));
                            return;
                        }
                        controller.enqueue({ type: 'text-delta', id: 't1', delta: `块${i}` });
                        await sleep(blockMs);
                    }
                    controller.enqueue({ type: 'text-end', id: 't1' });
                    controller.enqueue({
                        type: 'finish',
                        finishReason: { unified: 'stop', raw: 'stop' },
                        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
                    });
                    controller.close();
                },
            }),
        }),
    }) as never;
}

async function collect(stream: AsyncGenerator<SessionDelta>): Promise<SessionDelta[]> {
    const out: SessionDelta[] = [];
    for await (const d of stream) out.push(d);
    return out;
}

describe('真实用户中断（AbortSignal）', () => {
    // ⚠️ **这条是被实测纠正出来的认知**（和 2026-11-04 那次一样）：
    //    我以为「signal abort ⇒ chatStream 抛 AbortError」——**错**。
    //    实测：ai-sdk 把中断**优雅地收成流结束**（不抛），我们拿到的就是一个正常结束的流。
    //
    //    这对产品意味着什么：
    //      · 不会崩（好事）
    //      · 但「用户主动停」和「模型正常说完」在**流这一层长得一样** ——
    //        要靠外层（session / outcome）区分，不能只看 chatStream 有没有抛。
    //    所以这条测试记录的是**真实现状**，不是"应该怎样"。
    it('中途 abort ⇒ **不抛**，流优雅结束（真实现状，不是理想态）', async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);
        const stream = chatStream(slowModel(100, 10), [msg('写点长的')], { signal: controller.signal }, undefined, wire);
        const ds = await collect(stream); // 期望：能正常迭代完
        expect(ds.length, 'abort 之前的增量照常交付').toBeGreaterThan(0);
        expect(ds.at(-1)?.type, '结尾仍是 done —— 与正常说完无法从 delta 区分').toBe('done');
    });

    it('abort 之前已收到的 text 增量**不丢**（用户看到半截也是事实）', async () => {
        const controller = new AbortController();
        const got: string[] = [];
        setTimeout(() => controller.abort(), 150); // 让第一块（sleep 100）已经出来
        const stream = chatStream(slowModel(100, 10), [msg('写点长的')], { signal: controller.signal }, undefined, wire);
        try {
            for await (const d of stream) {
                if (d.type === 'text') got.push(d.text);
            }
        } catch {
            /* 期望抛 —— 这里只看「抛之前收到了什么」 */
        }
        expect(got.length, 'abort 前至少该收到一块').toBeGreaterThan(0);
    });

    // 同样是被实测纠正的：已 abort 的 signal 传进来，**不抛，立刻返回一个只有 done 的流**。
    // 这是合理的（快速结束、不空转），所以断言改成「快 + 空流」，而不是「抛错」。
    it('**已经开始 abort 才调**（signal 已 aborted）⇒ 立刻返回空流，不空转', async () => {
        const controller = new AbortController();
        controller.abort();
        const stream = chatStream(slowModel(100, 10), [msg('x')], { signal: controller.signal }, undefined, wire);
        const started = Date.now();
        const ds = await collect(stream);
        expect(Date.now() - started, '不该等完 10 块 × 100ms').toBeLessThan(500);
        expect(ds.filter((d) => d.type === 'text'), '一个字都不该出').toHaveLength(0);
        expect(ds.at(-1)?.type).toBe('done');
    });

    it('不传 signal ⇒ 正常跑完（对照组）', async () => {
        const stream = chatStream(slowModel(1, 3), [msg('短一点')], undefined, undefined, wire);
        const ds = await collect(stream);
        expect(ds.filter((d) => d.type === 'text').length).toBe(3);
        expect(ds.at(-1)?.type).toBe('done');
    });
});
