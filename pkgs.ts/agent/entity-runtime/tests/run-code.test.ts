import { describe, expect, it } from 'vitest';

import { InProcessVmRuntime } from '@diy-agent/code-runtime';

import { runCodeTool, DEFAULT_RUN_CODE_TIMEOUT_MS } from '../src/tools/run-code';

const runtime = new InProcessVmRuntime();

/** 调工具（绕过 ai SDK 的 tool-call 编排，直接跑 execute） */
async function callTool(
    tool: ReturnType<typeof runCodeTool>,
    input: { code: string; timeoutMs?: number },
): Promise<Record<string, unknown>> {
    const run = tool.execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
    return run(input, { toolCallId: 't1', messages: [] });
}

describe('run_code 工具', () => {
    it('模型代码里能 await api 调用并拿回结构化结果', async () => {
        const tool = runCodeTool({
            runtime,
            api: { bots: { list: async (): Promise<Array<{ id: string }>> => [{ id: 'b1' }, { id: 'b2' }] } },
            apiHelp: [{ path: 'diy2.bots.list', desc: '列 bot', mode: 'unary' }],
        });
        const out = await callTool(tool, {
            code: 'const bots = await api.bots.list({}); return bots.map((b) => b.id);',
        });
        expect(out['outcome']).toBe('ok');
        expect(out['value']).toEqual(['b1', 'b2']);
    });

    it('apiHelp() 能列出可调方法（api 是 Proxy，没有这份就检索不了）', async () => {
        const tool = runCodeTool({
            runtime,
            api: {},
            apiHelp: [{ path: 'diy2.rooms.create', desc: '建房间', mode: 'unary' }],
        });
        const out = await callTool(tool, { code: 'return apiHelp();' });
        expect(out['value']).toEqual([{ path: 'diy2.rooms.create', desc: '建房间', mode: 'unary' }]);
    });

    it('console 输出随结果返回', async () => {
        const tool = runCodeTool({ runtime, api: {} });
        const out = await callTool(tool, { code: 'console.log("hi"); return 1;' });
        expect(out['logs']).toEqual([{ level: 'log', text: 'hi' }]);
    });

    it('超时按 outcome=timeout 收场（不抛）', async () => {
        const tool = runCodeTool({ runtime, api: {} });
        const out = await callTool(tool, { code: 'while (true) {}', timeoutMs: 30 });
        expect(out['outcome']).toBe('timeout');
    });

    it('没有 api 时说明书写明"没有挂 RPC"', () => {
        const withoutApi = runCodeTool({ runtime });
        const withApi = runCodeTool({ runtime, api: {} });
        expect(withoutApi.description).toContain('没有挂 RPC');
        expect(withApi.description).toContain('apiHelp()');
    });

    it('缺省预算不是 0（= 不设超时那个坑）', () => {
        expect(DEFAULT_RUN_CODE_TIMEOUT_MS).toBeGreaterThan(0);
        expect(DEFAULT_RUN_CODE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    });
});
