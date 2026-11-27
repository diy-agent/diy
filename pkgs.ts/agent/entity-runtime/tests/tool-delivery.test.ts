// tool-delivery.test.ts —— 投递层**给每个工具都接上**（2026-11-27 的根因回归）
//
// 根因：`toModelOutput` 只传给了 bash。read / run_code / job 各自另立预算，真遇到大输出时
// 要么当场顶爆这一轮请求，要么被裁两遍。
// 这里钉的是三件事：
//   ① 遍历 ToolSet 注入 ⇒ 没有「哪个工具忘了接」；
//   ② 图片这类非文本内容**不许变成 JSON**（变成字符串 = 模型再也看不见它）；
//   ③ 一份预算常量跨包同值（tools / jobs / code-runtime 不再各报各的数）。

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '@diy-agent/code-runtime';
import { MAX_TAIL_BYTES } from '@diy-agent/jobs/run-status';
import { READ_MAX_BYTES, READ_MAX_LINES, TOOL_OUTPUT_MAX_BYTES, TOOL_OUTPUT_MAX_LINES } from '@diy-agent/tools';

import { capEveryTool, renderToolOutput } from '../src/tools/delivery';
import { buildRoomTools } from '../src/tools/index';
import { createToolOutputCapper, toolOutDir } from '../src/tool-output';

const dirs: string[] = [];
async function homeOf(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'diy2-delivery-'));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

/** 只用来喂结果的假工具（不出网、不落盘） */
function fakeTool(execute: () => unknown, extra: { toModelOutput?: (opts: never) => unknown } = {}) {
    return tool({
        description: 'fake',
        inputSchema: z.object({}),
        execute,
        ...extra,
    });
}

async function modelOutput(tools: ToolSet, name: string, output: unknown, toolCallId = 'call_1'): Promise<unknown> {
    const t = tools[name] as { toModelOutput: (o: { toolCallId: string; input: unknown; output: unknown }) => unknown };
    return t.toModelOutput({ toolCallId, input: {}, output });
}

describe('capEveryTool：遍历注入', () => {
    it('没有自己 toModelOutput 的工具也被挂上（这是根因本身）', async () => {
        const capped = capEveryTool({ plain: fakeTool(() => 'hi') }, async (text) => text);
        expect(typeof (capped['plain'] as { toModelOutput?: unknown }).toModelOutput).toBe('function');
        expect(await modelOutput(capped, 'plain', 'hi')).toEqual({ type: 'text', value: 'hi' });
    });

    it('未超限：字符串逐字符原样（不顺手规整、不加 marker）', async () => {
        const home = await homeOf();
        const capped = capEveryTool({ plain: fakeTool(() => '') }, createToolOutputCapper({ home }));
        const text = 'a\nb\tc\n';
        expect(await modelOutput(capped, 'plain', text)).toEqual({ type: 'text', value: text });
    });

    it('超限：结构化对象也被裁（run_code / job / unit_* 走的就是这条）', async () => {
        const home = await homeOf();
        const capped = capEveryTool({ plain: fakeTool(() => '') }, createToolOutputCapper({ home }));
        // 12000 行 ≈ 120KB（超出 64KB 预算）；注：JSON 里的换行会转义成 `\n`，行数只剩一行，
        // 所以这里考的是**字节**这一道闸，不是行数
        const huge = { value: lines(12_000), logs: [] };
        const out = (await modelOutput(capped, 'plain', huge, 'call_obj')) as { type: string; value: string };

        expect(out.type).toBe('text');
        expect(out.value.length).toBeLessThan(JSON.stringify(huge, null, 2).length / 2);
        // 原文落盘、marker 里给可 read 回来的路径
        const orig = path.join(toolOutDir(home)!, 'call_obj.txt');
        expect(out.value).toContain(orig);
        expect(await readFile(orig, 'utf8')).toBe(JSON.stringify(huge, null, 2));
    });

    it('已有的 toModelOutput 先跑、再裁（bash 不被顶掉）', async () => {
        const home = await homeOf();
        const own = () => ({ type: 'text' as const, value: lines(6000) });
        const capped = capEveryTool(
            { bashish: fakeTool(() => '', { toModelOutput: own as never }) },
            createToolOutputCapper({ home }),
        );
        const out = (await modelOutput(capped, 'bashish', 'ignored')) as { value: string };
        expect(out.value).toContain('line 1');
        expect(out.value).not.toContain('line 3000');
    });
});

describe('capEveryTool：非文本内容不许被 JSON 化', () => {
    const png = { type: 'file' as const, data: { type: 'data' as const, data: new Uint8Array([137, 80, 78, 71]) }, mediaType: 'image/png', filename: 'x.png' };
    const content = {
        type: 'content' as const,
        value: [{ type: 'text' as const, text: `看一眼这张图：x.png` }, png],
    };

    it('view_image 的图片块原样过，只有文本块可能被裁', async () => {
        const home = await homeOf();
        const capped = capEveryTool({ view_image: fakeTool(() => content) }, createToolOutputCapper({ home }));
        const out = (await modelOutput(capped, 'view_image', content, 'call_img')) as {
            type: string;
            value: { type: string; text?: string; data?: unknown }[];
        };

        expect(out.type).toBe('content');
        expect(out.value[1]).toEqual(png); // 图片逐字段不变
        expect(out.value[0]?.['text']).toBe('看一眼这张图：x.png');
    });

    it('多个文本块各自落盘，resume 不互相覆盖', async () => {
        const home = await homeOf();
        const two = { type: 'content' as const, value: [{ type: 'text' as const, text: lines(3000) }, { type: 'text' as const, text: lines(3000) }] };
        const capped = capEveryTool({ t: fakeTool(() => two) }, createToolOutputCapper({ home }));
        const out = (await modelOutput(capped, 't', two, 'call_two')) as { value: { text: string }[] };

        expect(out.value[0]?.text).toContain('call_two.txt');
        expect(out.value[1]?.text).toContain('call_two-t1.txt');
    });
});

describe('renderToolOutput', () => {
    it('字符串与 {type:text} 原样，对象走 JSON（indent 2：紧凑单行会被单行上限切中段）', () => {
        expect(renderToolOutput('x')).toEqual({ type: 'text', value: 'x' });
        expect(renderToolOutput({ type: 'text', value: 'x' })).toEqual({ type: 'text', value: 'x' });
        const json = renderToolOutput({ a: 1 });
        expect(json.type).toBe('text');
        expect(json.type === 'text' && json.value).toBe('{\n  "a": 1\n}');
    });
});

describe('一份预算常量（跨包同值）', () => {
    it('read 的窗口 = 投递层预算（read 的输出不会再被裁第二遍）', () => {
        expect(READ_MAX_BYTES).toBe(TOOL_OUTPUT_MAX_BYTES);
        expect(READ_MAX_LINES).toBe(TOOL_OUTPUT_MAX_LINES);
    });

    it('run_code 的生产者侧上限 = 同一预算', () => {
        expect(DEFAULT_LIMITS.logBytes).toBe(TOOL_OUTPUT_MAX_BYTES);
        expect(DEFAULT_LIMITS.valueChars).toBe(TOOL_OUTPUT_MAX_BYTES);
    });

    it('job 的 tail 字节上限 = 同一预算', () => {
        expect(MAX_TAIL_BYTES).toBe(TOOL_OUTPUT_MAX_BYTES);
    });
});

describe('buildRoomTools：装配即接线', () => {
    it('装配出来的每个工具都带 toModelOutput（read / write / edit / view_image 一个不漏）', async () => {
        const cwd = await homeOf();
        const tools = buildRoomTools({ cwd, toModelOutput: async (text) => text });
        expect(Object.keys(tools).length).toBeGreaterThanOrEqual(4);
        for (const [name, def] of Object.entries(tools)) {
            expect(typeof (def as { toModelOutput?: unknown }).toModelOutput, name).toBe('function');
        }
    });

    it('不传 toModelOutput 的宿主不接线（作者没要，就别偷偷加一层）', async () => {
        const cwd = await homeOf();
        const tools = buildRoomTools({ cwd });
        expect((tools['read'] as { toModelOutput?: unknown }).toModelOutput).toBeUndefined();
    });
});
