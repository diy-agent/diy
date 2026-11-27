// tools.test.ts —— 房间工具（read / write / edit / bash）的边界。
//
// 只测 diy2 自己那一层：路径解析（不设边界）、唯一命中、失败抛异常（不是"返回失败字符串"）。
// 工具语义（读窗口 / 原子写 / diff / 退出码口径）已归 `@diy-agent/tools` 内核 ——
// 这里断言的是"房间拿到的就是内核那份"，不重复测内核的细节。

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRoomTools, DEFAULT_BASH_TIMEOUT_MS } from '../src/tools/index';

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
        const written = String(
            await toolOf(tools, 'write').execute({ path: 'notes/a.txt', content: '第一行\n第二行\n第三行' }),
        );
        // 内核的写回执：一行摘要 + unified diff（以前那份移植只回一句"已写入"）
        expect(written).toContain('新建');
        expect(written).toContain('+第一行');

        const text = String(await toolOf(tools, 'read').execute({ path: 'notes/a.txt' }));
        expect(text).toContain('共 3 行');
        expect(text).toContain('1: 第一行');
        expect(text).toContain('3: 第三行');
        expect(await readFile(join(dir, 'notes/a.txt'), 'utf8')).toBe('第一行\n第二行\n第三行');
    });

    // 房间目录**不是**可写范围（2026-11-21 用户裁，与内核 / diy1 同口径）：任务在 git worktree 里时
    // 文件就在房间目录之外，拦了只能退回 bash 写、绕开 diff 摘要与审计。这条是契约变更的正面证据 ——
    // 防有人把护栏又加回去。
    it('房间外路径不拦：绝对路径与 ../ 都照常读写（房间目录只是相对路径基准）', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'diy2-tools-outside-'));
        try {
            const tools = buildRoomTools({ cwd: dir, shell: false });
            const target = join(outside, 'far.txt');

            const written = String(await toolOf(tools, 'write').execute({ path: target, content: '外面' }));
            expect(written).toContain('新建');
            expect(String(await toolOf(tools, 'read').execute({ path: target }))).toContain('1: 外面');

            await toolOf(tools, 'edit').execute({
                path: target,
                edits: [{ oldText: '外面', newText: '改过' }],
            });
            expect(await readFile(target, 'utf8')).toBe('改过');

            // 相对路径的 `../` 同样放行（不再有"越界"这回事）
            const up = `../${outside.split('/').pop() ?? ''}/far.txt`;
            expect(String(await toolOf(tools, 'read').execute({ path: up }))).toContain('改过');
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('edit：唯一命中才改，多处命中要 replaceAll', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        await toolOf(tools, 'write').execute({ path: 'b.txt', content: 'a\nb\na\n' });

        await expect(
            toolOf(tools, 'edit').execute({ path: 'b.txt', edits: [{ oldText: 'a', newText: 'x' }] }),
        ).rejects.toThrow(/出现 2 次/);

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
        ).rejects.toThrow(/找不到/);
    });

    it('bash 缺省带执行预算（不是"不设超时"）：值抄 diy1 的 300s', () => {
        // 回归钉子：这里曾经是 `?? 0`（= 不限），一条卡死的命令能把整轮挂到人来看，
        // 而步数刹车管不到它。要放开只能显式传 0。
        expect(DEFAULT_BASH_TIMEOUT_MS).toBe(300_000);
    });

    it('bash：在房间目录执行，退出码与输出都在结果里', async () => {
        const tools = buildRoomTools({ cwd: dir, shell: true, bashTimeoutMs: 10_000 });
        const out = String(await toolOf(tools, 'bash').execute({ command: 'pwd && echo hi' }));
        expect(out).toContain('exit_code: 0');
        expect(out).toContain('hi');
        // cwd 打的是 realpath（macOS 的 /var → /private/var），别拿构造时的字符串硬比
        expect(out).toContain(await realpath(dir));
    });

    it('ask 不阻塞：调用后立刻返回回执，提问同时推到界面', async () => {
        const { AskGate } = await import('../src/ask');
        const seen: Array<{ questions: Array<{ question: string; options?: unknown }> }> = [];
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

        expect(seen.map((request) => request.questions[0]?.question)).toEqual(['先做哪个？']);
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
                settled.push({ askId: request.askId, text: result.answer?.answers[0]?.values?.join(','), owner }),
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
        expect(gate.answer(askId, { answers: [{ id: 'q1', values: ['test_first'] }] })).toEqual({ ok: true });
        expect(settled).toEqual([{ askId, text: 'test_first', owner: 'bot:a' }]);
        expect(gate.pendingCount()).toBe(0);
    });

    it('describeAnswer：只填自由输入、什么都没勾，那段文字必须带上（不能变成"没有选任何选项"）', async () => {
        const { describeAnswer } = await import('../src/ask');
        const request = {
            askId: 'ask-1',
            questions: [
                {
                    id: 'q1',
                    question: '先做哪个？',
                    kind: 'choice' as const,
                    options: [
                        { value: 'a', label: '方案 A' },
                        { value: 'b', label: '方案 B' },
                    ],
                },
            ],
            at: 0,
        };
        const only = (answer: { values?: string[]; text?: string }) => ({ answers: [{ id: 'q1', ...answer }] });

        expect(describeAnswer(request, only({ values: [], text: '我还是没想明白，先改成异步吧' }))).toBe(
            '我还是没想明白，先改成异步吧',
        );
        expect(describeAnswer(request, only({ values: ['b'], text: '顺便说一句' }))).toBe(
            '方案 B（b）；补充：顺便说一句',
        );
        // label 和 value 一样时不重复：`json（json）` 只是噪音
        expect(
            describeAnswer(
                {
                    ...request,
                    questions: [
                        {
                            id: 'q1',
                            question: '日志格式？',
                            kind: 'choice' as const,
                            options: [
                                { label: 'json', value: 'json' },
                                { label: '文本', value: 'text' },
                            ],
                        },
                    ],
                },
                only({ values: ['json', 'text'] }),
            ),
        ).toBe('json、文本（text）');
        // 表单里的补充文字同样不能丢
        expect(
            describeAnswer(
                {
                    ...request,
                    questions: [
                        {
                            id: 'q1',
                            question: '填一下发版信息',
                            kind: 'form' as const,
                            fields: [{ name: 'title', label: '标题', type: 'text' }],
                        },
                    ],
                },
                only({ fields: { title: '发版' }, text: '别改版本号' }),
            ),
        ).toBe('- 标题：发版\n补充：别改版本号');

        // 文字题：只有空白（或干脆没有 text）时要说“空”，不能拼出「回答提问「…」：」后面什么都没有
        const textAsk = {
            ...request,
            questions: [{ id: 'q1', question: '随便说说', kind: 'text' as const }],
        };
        expect(describeAnswer(textAsk, only({ text: '   ' }))).toBe('（空）');
        expect(describeAnswer(textAsk, { answers: [{ id: 'q1' }] })).toBe('（空）');
        expect(describeAnswer(textAsk, only({ text: ' 就它了 ' }))).toBe('就它了');
    });

    it('bash 非零退出：抛错，但诊断（退出码 + stderr）在 error 里给全', async () => {
        // 内核口径（##353）：非零退出是**工具失败**，抛而不是 return —— 返回字符串会被 SDK
        // 当成正常结果画 ✓（"✓ + Command failed" 那种自相矛盾）。模型侧照样看得到诊断。
        const tools = buildRoomTools({ cwd: dir, shell: true, bashTimeoutMs: 10_000 });
        await expect(toolOf(tools, 'bash').execute({ command: 'echo boom >&2; exit 3' })).rejects.toThrow(
            /exit_code: 3[\s\S]*boom/,
        );
    });

    it('journal：写一条走回调（不落文件、不进 cwd）', async () => {
        const seen: Array<{ kind: string; text: string }> = [];
        const tools = buildRoomTools({
            cwd: dir,
            shell: false,
            onJournal: (input) => {
                seen.push(input);
            },
        });
        await toolOf(tools, 'journal').execute({ kind: 'decision', text: '选了 A' });
        expect(seen).toEqual([{ kind: 'decision', text: '选了 A' }]);
    });
});
