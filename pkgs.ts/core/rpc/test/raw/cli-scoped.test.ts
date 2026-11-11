/**
 * cli-scoped.test.ts — 「挂载点与模块分离」+ `CliApp.inProcess` 一句话构造
 *
 * 验三件事：
 *   1. 模块只有 api，**前缀由使用方给**：同一个 api 能挂到两个不同前缀（多租户）
 *   2. CLI 是纯路由器：命令段来自 client 的 `cmd`，线上名来自 `prefix`
 *   3. `CliApp.inProcess(...)` 一句构造，`run()` 直接拿 `{ code, out, err }`
 *      —— 不用再手写 out/err/exit 哨兵与 mem 通道
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RpcSchema } from '../../src/core/rpc.js';
import { CliApp } from '../../src/cli/index.js';

// ── 模块：只有 api，没有名字 ──
const taskApi = RpcSchema.group({
    desc: '任务管理',
    children: {
        list: RpcSchema.unary({
            desc: '列出任务',
            input: { state: z.enum(['pending', 'done']).optional().cliOption({ desc: '按状态过滤' }) },
            output: z.array(z.object({ uri: z.string(), state: z.string() })),
        }),
        create: RpcSchema.unary({
            desc: '创建任务',
            input: { title: z.string().cliArg({ desc: '标题' }) },
            output: z.object({ uri: z.string() }),
        }),
    },
});

const agentApi = RpcSchema.group({
    desc: '本地 agent',
    children: {
        list: RpcSchema.unary({
            desc: '列出会话',
            input: {},
            output: z.array(z.object({ taskUri: z.string() })),
        }),
    },
});

const TASKS = [{ uri: 'projects/1/tasks/7', state: 'pending' }];

function harness() {
    return CliApp.inProcess({
        name: 'diy',
        version: '1.0.0',
        scopes: [
            {
                prefix: 'diy.task',
                cmd: 'task',
                desc: '任务管理',
                api: taskApi,
                handlers: {
                    list: ({ input }: any) => (input.state ? TASKS.filter((t) => t.state === input.state) : TASKS),
                    create: ({ input }: any) => ({ uri: `projects/1/tasks/9（${input.title}）` }),
                },
            },
            {
                prefix: 'diy.agent',
                cmd: 'agent',
                api: agentApi,
                handlers: { list: () => [{ taskUri: 'projects/1/tasks/7' }] },
            },
        ],
    });
}

describe('CliApp.inProcess + scoped clients', () => {
    it('注册名 = prefix + 树内 path（模块自己不知道前缀）', () => {
        const cli = harness();
        try {
            expect(cli.listRegistered().sort()).toEqual([
                'diy.agent.list',
                'diy.task.create',
                'diy.task.list',
            ]);
        } finally {
            cli.dispose();
        }
    });

    it('命令段来自 cmd，调用走向对应 prefix', async () => {
        const cli = harness();
        try {
            const r = await cli.run(['task', 'list', '--json']);
            expect(r.code).toBe(0);
            expect(JSON.parse(r.out.join('\n')).data).toEqual(TASKS);
        } finally {
            cli.dispose();
        }
    });

    it('多个 scope 合成一棵命令树（help 里各有 desc）', async () => {
        const cli = harness();
        try {
            const r = await cli.run(['--help']);
            expect(r.out.join('\n')).toContain('task');
            expect(r.out.join('\n')).toContain('agent');
            expect(r.out.join('\n')).toContain('任务管理');
        } finally {
            cli.dispose();
        }
    });

    it('位置参数与选项照旧生效', async () => {
        const cli = harness();
        try {
            const r = await cli.run(['task', 'create', '写文档']);
            expect(r.out.join('\n')).toContain('写文档');
        } finally {
            cli.dispose();
        }
    });

    it('命令段冲突 → 构造期报错（不是运行时撞车）', () => {
        expect(() =>
            CliApp.inProcess({
                name: 'diy',
                scopes: [
                    { prefix: 'a.task', cmd: 'task', api: taskApi, handlers: { list: () => [], create: () => ({ uri: '' }) } },
                    { prefix: 'b.task', cmd: 'task', api: agentApi, handlers: { list: () => [] } },
                ],
            }),
        ).toThrow(/命令段/);
    });
});
