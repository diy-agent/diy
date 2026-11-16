// tools.test.ts —— 房间工具（read / write / edit / bash）的边界。
//
// 只测我们自己装配与移植的那一层：路径护栏、唯一命中、失败抛异常（不是"返回失败字符串"）。

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRoomTools } from '../src/tools/index';

/** ToolSet 里的 execute 签名带 SDK 参数，测试只喂输入 */
type Executable = { execute: (input: unknown) => Promise<unknown> };

function toolOf(tools: ReturnType<typeof buildRoomTools>, name: string): Executable {
    return tools[name] as unknown as Executable;
}

let dir = '';

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diy2-tools-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('房间工具', () => {
    it('write → read：内容落盘，读回来带行号', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        await toolOf(tools, 'write').execute({ path: 'notes/a.txt', content: '第一行\n第二行\n第三行' });

        const text = String(await toolOf(tools, 'read').execute({ path: 'notes/a.txt' }));
        expect(text).toContain('共 3 行');
        expect(text).toContain('1\t第一行');
        expect(text).toContain('3\t第三行');
        expect(await readFile(join(dir, 'notes/a.txt'), 'utf8')).toBe('第一行\n第二行\n第三行');
    });

    it('read 越界：路径不在房间目录内 → 抛错', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        await expect(toolOf(tools, 'read').execute({ path: '../../etc/passwd' })).rejects.toThrow(/越界/);
    });

    it('edit：唯一命中才改，多处命中要 replaceAll', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        await toolOf(tools, 'write').execute({ path: 'b.txt', content: 'a\nb\na\n' });

        await expect(
            toolOf(tools, 'edit').execute({ path: 'b.txt', edits: [{ oldText: 'a', newText: 'x' }] }),
        ).rejects.toThrow(/命中 2 处/);

        await toolOf(tools, 'edit').execute({
            path: 'b.txt',
            edits: [{ oldText: 'a', newText: 'x', replaceAll: true }],
        });
        expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('x\nb\nx\n');
    });

    it('edit 未命中 → 抛错（不当成正常结果）', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        await toolOf(tools, 'write').execute({ path: 'c.txt', content: 'hello' });
        await expect(
            toolOf(tools, 'edit').execute({ path: 'c.txt', edits: [{ oldText: 'nope', newText: 'x' }] }),
        ).rejects.toThrow(/未命中/);
    });

    it('bash：在房间目录执行，退出码与输出都在结果里', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: true, bashTimeoutMs: 10_000 });
        const out = String(await toolOf(tools, 'bash').execute({ command: 'pwd && echo hi' }));
        expect(out).toContain('exit: 0');
        expect(out).toContain('hi');
        expect(out).toContain(dir);
    });

    it('ask 不阻塞：调用后立刻返回回执，提问同时推到界面', async () => {
        const { AskGate } = await import('../src/ask');
        const seen: Array<{ question: string; options?: unknown }> = [];
        const gate = new AskGate({ request: (request) => seen.push(request), settle: () => undefined });
        const tools = buildRoomTools({ cwd: dir, shell: false, ask: gate });

        const out = String(
            await toolOf(tools, 'ask').execute({
                question: '先做哪个？',
                options: [
                    { value: 'a', label: '方案 A' },
                    { value: 'b', label: '方案 B' },
                ],
            }),
        );

        expect(seen.map((request) => request.question)).toEqual(['先做哪个？']);
        // 回执告诉模型"发出去了、别等、别自己猜"
        expect(out).toContain('提问已展示给用户');
        expect(out).toContain('不会阻塞你');
        // 挂起中，答案还没来
        expect(gate.pendingCount()).toBe(1);
    });

    it('ask 全链路：工具立即返回 → 用户之后作答 → 回答交给房间投递（带 owner）', async () => {
        const { AskGate } = await import('../src/ask');
        const settled: Array<{ askId: string; text?: string; owner?: string }> = [];
        const gate = new AskGate({
            request: () => undefined,
            settle: (request, result, owner) =>
                settled.push({ askId: request.askId, text: result.answer?.values?.join(','), owner }),
        });
        const tools = buildRoomTools({ cwd: dir, shell: false, ask: gate, askOwner: 'bot:a' });

        const out = String(
            await toolOf(tools, 'ask').execute({
                question: '先做哪个？',
                options: [
                    { value: 'test_first', label: '先做测试' },
                    { value: 'feature_first', label: '先做功能' },
                ],
            }),
        );
        expect(out).toContain('新的用户消息');
        expect(settled).toEqual([]);

        const askId = gate.list()[0]!.askId;
        expect(gate.answer(askId, { values: ['test_first'] })).toBe(true);
        expect(settled).toEqual([{ askId, text: 'test_first', owner: 'bot:a' }]);
        expect(gate.pendingCount()).toBe(0);
    });

    it('describeAnswer：只填自由输入、什么都没勾，那段文字必须带上（不能变成"没有选任何选项"）', async () => {
        const { describeAnswer } = await import('../src/ask');
        const request = {
            askId: 'ask-1',
            question: '先做哪个？',
            kind: 'choice' as const,
            options: [
                { value: 'a', label: '方案 A' },
                { value: 'b', label: '方案 B' },
            ],
            at: 0,
        };

        expect(describeAnswer(request, { values: [], text: '我还是没想明白，先改成异步吧' })).toBe(
            '我还是没想明白，先改成异步吧',
        );
        expect(describeAnswer(request, { values: ['b'], text: '顺便说一句' })).toBe('方案 B（b）；补充：顺便说一句');
        // 表单里的补充文字同样不能丢
        expect(
            describeAnswer(
                {
                    ...request,
                    kind: 'form',
                    options: undefined,
                    fields: [{ name: 'title', label: '标题', type: 'text' }],
                },
                { fields: { title: '发版' }, text: '别改版本号' },
            ),
        ).toBe('- 标题：发版\n补充：别改版本号');

        // 文字题：只有空白（或干脆没有 text）时要说“空”，不能拼出「回答提问「…」：」后面什么都没有
        const textAsk = { ...request, kind: 'text' as const, options: undefined };
        expect(describeAnswer(textAsk, { text: '   ' })).toBe('（空）');
        expect(describeAnswer(textAsk, {})).toBe('（空）');
        expect(describeAnswer(textAsk, { text: ' 就它了 ' })).toBe('就它了');
    });

    it('bash 非零退出：返回结果而不是抛错（靠退出码改命令）', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: true, bashTimeoutMs: 10_000 });
        const out = String(await toolOf(tools, 'bash').execute({ command: 'echo boom >&2; exit 3' }));
        expect(out).toContain('exit: 3');
        expect(out).toContain('boom');
    });
});
