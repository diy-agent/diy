/**
 * 02-multi-module-root —— **多个模块合并成同一个根命令**（diy 的实际形态）
 *
 *   npx tsx pkgs.ts/core/rpc/examples/cli/02-multi-module-root/run.ts
 *
 * 形态：
 *
 *   demo task list          ← task 模块
 *   demo task create "标题"
 *   demo agent list         ← agent 模块
 *
 * ## 核心：模块没有名字，前缀是使用方给的
 *
 * ```ts
 * export const taskApi = RpcSchema.group({ ... });          // 模块只提供 api
 *
 * server.use({ prefix: 'diy.task', api: taskApi, handlers });  // 部署位置在这里定
 * const task = createScopedClient({ api: taskApi, client, prefix: 'diy.task', cmd: 'task' });
 * ```
 *
 * 所以同一份 `taskApi` 可以被挂到 `diy.task`，也可以挂到 `diyvideo.task` ——
 * 换部署位置不用动模块源码（对比：`defineService({ name })` 把它焊死）。
 *
 * ## 三个概念（以前混在一起，是根命令所有麻烦的来源）
 *
 * | 概念 | 谁定 | 例子 |
 * |---|---|---|
 * | 线上名 | `prefix` + 树内 path | `diy.task.list` |
 * | 命令段 | `cmd` + 树内 path | `task list` |
 * | 模块 | 模块作者 | `taskApi`（无名字） |
 */
import { z } from 'zod';
import { RpcSchema } from '../../../src/core/rpc';
import { CliApp } from '../../../src/cli/index';

// ═══ 模块 A：task（没有名字） ═══
export const taskApi = RpcSchema.group({
    desc: '任务管理',
    children: {
        list: RpcSchema.unary({
            desc: '列出任务',
            input: { state: z.enum(['pending', 'done']).optional().cliOption({ desc: '按状态过滤' }) },
            output: z.array(z.object({ uri: z.string(), title: z.string() })),
        }),
        create: RpcSchema.unary({
            desc: '创建任务',
            input: { title: z.string().cliArg({ desc: '任务标题' }) },
            output: z.object({ uri: z.string() }),
        }),
    },
});

// ═══ 模块 B：agent（同样没有名字） ═══
export const agentApi = RpcSchema.group({
    desc: '本地 agent',
    children: {
        list: RpcSchema.unary({
            desc: '列出会话',
            input: { running: z.boolean().optional().cliOption({ desc: '只看运行中的' }) },
            output: z.array(z.object({ taskUri: z.string(), state: z.string() })),
        }),
    },
});

const TASKS = [{ uri: 'projects/1/tasks/7', title: '示例任务' }];

async function main(): Promise<void> {
    // 一句话：起 mem 通道 + 服务端 + 各 scope 的客户端，返回可运行的 CLI
    const cli = CliApp.inProcess({
        name: 'demo',
        version: '1.0.0',
        scopes: [
            {
                prefix: 'demo.task',
                cmd: 'task',
                api: taskApi,
                handlers: {
                    list: ({ input }: any) => (input.state ? TASKS.filter(() => input.state === 'done') : TASKS),
                    create: ({ input }: any) => ({ uri: `projects/1/tasks/${TASKS.length + 8}（${input.title}）` }),
                },
            },
            {
                prefix: 'demo.agent',
                cmd: 'agent',
                api: agentApi,
                handlers: { list: () => [{ taskUri: 'projects/1/tasks/7', state: 'running' }] },
            },
        ],
    });

    try {
        // 服务端注册名 = 各 scope 的 prefix + 树内 path
        console.log('服务端注册名:', cli.listRegistered().sort().join(', '), '\n');

        const show = async (label: string, argv: string[]) => {
            const r = await cli.run(argv);
            console.log(`$ ${label}`);
            console.log(r.out.join('\n') || r.err.join('\n'));
            console.log();
        };

        await show('demo --help（根层只是命名空间，打帮助）', ['--help']);
        await show('demo task list --json', ['task', 'list', '--json']);
        await show('demo task create "写文档"', ['task', 'create', '写文档']);
        await show('demo agent list', ['agent', 'list']);

        // ── 同一个模块挂两个前缀：多租户 / 兼容别名 ──
        console.log('同一个 taskApi 还能挂到 demo.task2（模块源码一行没改）：');
        const multi = CliApp.inProcess({
            name: 'demo',
            scopes: [
                { prefix: 'demo.task', cmd: 'task', api: taskApi, handlers: { list: () => TASKS, create: () => ({ uri: '' }) } },
                { prefix: 'demo.task2', cmd: 'task2', api: taskApi, handlers: { list: () => TASKS, create: () => ({ uri: '' }) } },
            ],
        });
        console.log('  注册名:', multi.listRegistered().sort().join(', '));
        multi.dispose();
    } finally {
        cli.dispose();
    }
}

void main();
