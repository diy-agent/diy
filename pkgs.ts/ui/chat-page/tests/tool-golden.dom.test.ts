// @vitest-environment happy-dom
//
// tool-golden.dom.test.ts — **真实录制的事件流 → Block → 渲染** 全链路
//
// 这是 golden fixture 第一次被**业务代码**消费（之前只有 pkgs.ts/test/llm 自验）。
// 链路：
//   fixtures/llm/gen/tool-ok.gen.ts   （真模型 deepseek-v4.1-flash 录的 provider 层事件）
//     → 抽出 tool-call part
//     → 转成 core 的 AgentEvent（toolCallId→id / toolName→name / input→args）
//     → toBlocks()                        ← 业务代码
//     → renderBlock()                     ← 业务代码
//     → 断言 DOM
//
// 为什么值得：手写 Block 的测试（block-renderers.dom.test.ts）证明「渲染对不对」，
// 这里证明「**真模型返回的东西**能不能走通这条链」—— 字段名对不上、参数格式变了
// 这类问题只有真数据能暴露。

import { describe, expect, it } from 'vitest';
import { toolOk } from '@diy-agent/test-llm/fixtures';
import { toBlocks } from '../src/blocks.js';
import { renderBlock } from '../src/block-renderers.js';

/** provider 层 tool-call part → core 的 AgentEvent（字段名对齐，是真实存在的映射） */
function agentEventsOf(parts: readonly { type: string }[]): { type: string; [k: string]: unknown }[] {
    const out: { type: string; [k: string]: unknown }[] = [];
    for (const p of parts) {
        const part = p as unknown as Record<string, unknown>;
        if (part['type'] === 'text-delta' && typeof part['delta'] === 'string') {
            out.push({ type: 'text-delta', text: part['delta'] });
        } else if (part['type'] === 'tool-call') {
            out.push({
                type: 'tool-call',
                id: part['toolCallId'],
                name: part['toolName'],
                args: part['input'],
            });
        }
    }
    return out;
}

describe('真实录制流 → 渲染', () => {
    it('tool-ok fixture 里的 tool-call 能变成 tool 块（state=running）', () => {
        const blocks = toBlocks(agentEventsOf(toolOk));
        const toolBlocks = blocks.filter((b) => b.kind === 'tool');
        expect(toolBlocks.length, 'fixture 里应该有 tool-call').toBeGreaterThan(0);
        const first = toolBlocks[0]!;
        expect(first.data['state']).toBe('running');
        // 真实 fixture 的 toolName 是 read，参数里带 path
        expect(first.data['name']).toBe('read');
        expect(String(first.data['args'])).toContain('path');
    });

    it('渲染出来是 details（running 默认展开）且带 data-state', () => {
        const blocks = toBlocks(agentEventsOf(toolOk));
        const toolBlock = blocks.find((b) => b.kind === 'tool')!;
        const el = renderBlock(toolBlock) as HTMLDetailsElement;
        expect(el.tagName.toLowerCase()).toBe('details');
        expect(el.dataset['state']).toBe('running');
        expect(el.open, 'running 时应该展开').toBe(true);
    });

    it('fixture 的文本增量也能拼成 text 块（同一条流里的两段内容都对得上）', () => {
        const blocks = toBlocks(agentEventsOf(toolOk));
        const textBlocks = blocks.filter((b) => b.kind === 'text');
        // tool-ok 场景里模型给了 tool-call，正文可能为空 —— 有就断言非空，没有不断言
        for (const b of textBlocks) expect(String(b.data['text']).length).toBeGreaterThan(0);
    });
});
