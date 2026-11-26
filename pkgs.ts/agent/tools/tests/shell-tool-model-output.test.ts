// tests/shell-tool-model-output.test.ts
// 🎯 投递层截断的**异步**契约（2026-11-26 事故回归）
//
// 事故：`makeShellTool` 的 `toModelOutput` 忘了 `await host.toModelOutput(...)`，于是返回给
// SDK 的是 `{ type: 'text', value: Promise }`。序列化成 JSON 就变成 `content: {}` ——
// opencode 网关（gRPC 路径）直接 400 `tool message content must be a string or an array of
// text parts`，于是**每个多步工具轮都在第二步死掉**：模型永远走不到「规划 / 建账本」那一步。
//
// 为什么这一层必须有单测：宿主传进来的截断器天生是 async（要落盘原文），`await` 漏了不会报错、
// 类型也过得去（`value` 被推成 Promise 也算 object），只有真发一次请求才看得出来。
import { describe, expect, it } from 'vitest';

import { makeShellTool } from '../src/shell/tool.js';
import type { ShellSpec } from '../src/shell/spec.js';

const spec = { kind: 'bash', label: 'bash', bin: 'bash', args: (command: string) => ['-c', command] } as unknown as ShellSpec;

function tool(host: { toModelOutput?: (text: string, toolCallId: string) => string | Promise<string> }) {
    return makeShellTool(spec, {
        cwd: process.cwd(),
        limits: { bashTimeoutMs: 10_000 },
        ...(host.toModelOutput === undefined ? {} : { toModelOutput: host.toModelOutput }),
    }) as unknown as { toModelOutput: (opts: { toolCallId: string; input: unknown; output: unknown }) => Promise<{ type: string; value: unknown }> };
}

describe('makeShellTool 的 toModelOutput', () => {
    it('宿主给的是 async 截断器 ⇒ 交出去的 value 必须是**已解析的字符串**', async () => {
        const t = tool({ toModelOutput: async (text) => `${text} [capped]` });
        const out = await t.toModelOutput({ toolCallId: 'call-1', input: { command: 'echo hi' }, output: 'echo hi\n' });
        expect(out.type).toBe('text');
        // 关键断言：不是 Promise、不是 `{}`（JSON.stringify(Promise) === '{}'）
        expect(typeof out.value).toBe('string');
        expect(out.value).toBe('echo hi\n [capped]');
        expect(JSON.stringify({ value: out.value })).not.toContain('{}');
    });

    it('没有截断器时原样交回', async () => {
        const t = tool({});
        const out = await t.toModelOutput({ toolCallId: 'call-2', input: {}, output: 'plain' });
        expect(out).toEqual({ type: 'text', value: 'plain' });
    });
});
