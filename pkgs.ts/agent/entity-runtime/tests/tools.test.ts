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

    it('ask：选项题的回答格式化后返回给模型', async () => {
        const asked: string[] = [];
        const gate = {
            request: async (input: { question: string; options?: Array<{ value: string; label: string }> }) => {
                asked.push(input.question);
                return {
                    request: { askId: 'ask-1', question: input.question, kind: 'choice', options: input.options, at: 0 },
                    answer: { values: ['b'] },
                };
            },
        } as unknown as NonNullable<Parameters<typeof buildRoomTools>[0]['ask']>;
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
        expect(asked).toEqual(['先做哪个？']);
        expect(out).toContain('用户选择');
        expect(out).toContain('方案 B');
    });

    it('ask 全链路：工具挂起 → 用户回答 → 工具返回可读文本', async () => {
        const { AskGate } = await import('../src/ask');
        const seen: string[] = [];
        const gate = new AskGate({
            // 真实链路里这是"推到界面"；这里模拟用户立刻点了第一个选项
            request: (request) => {
                seen.push(request.question);
                gate.answer(request.askId, { values: ['test_first'] });
            },
            settle: () => undefined,
            timeoutMs: 0,
        });
        const tools = buildRoomTools({ cwd: dir, shell: false, ask: gate });

        const out = String(
            await toolOf(tools, 'ask').execute({
                question: '先做哪个？',
                options: [
                    { value: 'test_first', label: '先做测试' },
                    { value: 'feature_first', label: '先做功能' },
                ],
            }),
        );

        expect(seen).toEqual(['先做哪个？']);
        expect(out).toContain('用户选择：先做测试（test_first）');
        expect(gate.pendingCount()).toBe(0);
    });

    it('bash 非零退出：返回结果而不是抛错（模型靠退出码改命令）', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: true, bashTimeoutMs: 10_000 });
        const out = String(await toolOf(tools, 'bash').execute({ command: 'echo boom >&2; exit 3' }));
        expect(out).toContain('exit: 3');
        expect(out).toContain('boom');
    });
});
