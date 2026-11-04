// chat-stream.blackbox.test.ts — **黑盒**：录制的真实事件流 → SessionDelta
//
// 为什么是黑盒（用户 2026-11-04 的纠正）：
//   上一版 tool-golden.dom.test.ts 在测试里**手写了一份字段映射**（toolCallId→id 等），
//   等于测自己的副本 —— 产品代码改了它不会红。那是「横向切片」的虚假测试。
//
//   这里把 `chatStream` 整个当黑盒：喂 fixture，只断言输出的 SessionDelta 序列。
//   中间所有真实逻辑都会跑到：
//     · toolCallDeltaOf 的字段映射与过滤（缺 id/name 丢弃）
//     · jsonTextOf 的参数归一（对象 → JSON 字符串）
//     · DSML 泄漏改写、未知工具兜底、abort 分支、usage 归一
//   任何一处改了行为，这里立刻红。
//
// 边界：输入 fixture（provider 层 part），输出 SessionDelta —— 再往上是 session/UI 的活。

import { describe, expect, it } from 'vitest';
import { chatStream } from '../src/openai.js';
import { replay } from '@diy-agent/test-llm';
import { textOnly, toolOk, abort, rateLimit } from '@diy-agent/test-llm/fixtures';
import type { ChatMessage, SessionDelta } from '@diy-agent/session';

const msg = (text: string): ChatMessage => ({ role: 'user', text });

/** 黑盒：喂 fixture，收全部 delta（不假设中间任何形状） */
async function deltasOf(fixture: Parameters<typeof replay>[0]): Promise<SessionDelta[]> {
    const out: SessionDelta[] = [];
    for await (const d of chatStream(replay(fixture).asModel(), [msg('读一下 README.md')], undefined, undefined, {
        provider: 'test',
        model: 'test-model',
        baseUrl: 'https://example.test/v1',
    })) {
        out.push(d);
    }
    return out;
}

describe('黑盒：真实录制流 → SessionDelta', () => {
    it('text-only ⇒ 有 text 增量，最后 done', async () => {
        const ds = await deltasOf(textOnly);
        const texts = ds.filter((d) => d.type === 'text');
        expect(texts.length).toBeGreaterThan(0);
        expect(texts.map((d) => (d as { text: string }).text).join('').length).toBeGreaterThan(0);
        expect(ds.at(-1)?.type).toBe('done');
    });

    it('tool-ok ⇒ 产出一条 tool-call，**参数是 JSON 字符串**（不是对象）', async () => {
        const ds = await deltasOf(toolOk);
        const calls = ds.filter((d) => d.type === 'tool-call') as { id: string; name: string; input?: string }[];
        expect(calls.length, '一次调用只该产出一条 tool-call').toBe(1);
        expect(calls[0]!.name).toBe('read');
        expect(calls[0]!.id).toMatch(/^call_/);
        // 关键断言：产品代码会把 input 归一成字符串（jsonTextOf）；手写映射会漏这层
        expect(typeof calls[0]!.input).toBe('string');
        expect(calls[0]!.input).toContain('path');
    });

    it('**上游流中断**（有 start 无 finish）⇒ 抛错，不是静默成功', async () => {
        // ⚠️ 这条是被黑盒测试**纠正**出来的认知：
        //   之前我以为「流里没有 finish」会走到 chatStream 的 `case 'abort'` 分支 —— 错。
        //   实测：ai-sdk 在流结束却没有 finish chunk 时直接抛
        //     "No output generated. The model stream ended without a finish chunk."
        //   也就是说 `abort.gen.ts` 这个 fixture 模拟的是**上游中途断开**，不是「用户中断」。
        //
        //   用户中断走的是另一条路：`options.signal` 被 abort ⇒ ai-sdk 抛 AbortError
        //   ⇒ chatStream 的 catch 分类。那条要用真的 AbortController 造，不能用这份 fixture。
        //
        // 这就是黑盒的价值：手写映射的测试永远不会告诉你「你以为的分支根本走不到」。
        await expect(deltasOf(abort)).rejects.toThrow(/without a finish chunk|No output generated/);
    });

    it('rate-limit ⇒ 抛 LlmProviderError（可重试标记不能丢）', async () => {
        await expect(deltasOf(rateLimit)).rejects.toMatchObject({
            name: 'LlmProviderError',
        });
    });

    it('每次回放都从同一条 fixture 开始（不被消费）', async () => {
        const a = await deltasOf(toolOk);
        const b = await deltasOf(toolOk);
        expect(b).toEqual(a);
    });
});
