/**
 * 02-multi-module-root —— **多个模块合并成同一个根命令**（diy 的实际形态）
 *
 *   npx tsx pkgs.ts/core/rpc/examples/cli/02-multi-module-root/run.ts
 *
 * 形态：
 *
 *   demo task list          ← task 模块（defineService({ name: "demo.task" })）
 *   demo task create "标题"
 *   demo agent list         ← agent 模块（defineService({ name: "demo.agent" })）
 *
 * 每个模块自带 `defineService`，**没有任何中心化的组装点去改它们的 api**：
 * 根只是把各自的 `routes` 挂到自己的名字下。这就是「模块自己注册」在命令树上的样子。
 *
 * ## 根命令的三个坑（本文件末尾会逐个打出来验证）
 *
 * ① **拼名两边各有各的规则**：服务端 `service.name + path`（`demo.task` + `list`），
 *    客户端 `rpcPrefix + 命令路径`（`demo.` + `task.list`）。差一个字符就是 `Unknown method`。
 * ② **根这一层不能执行**：`demo` 只是命名空间，敲 `demo` 应该是 help，不是一个 RPC 调用。
 * ③ **根被当 router 传进来时，命令段会多一层**：直接传 `apiDef`（含 `demo` 那层）→
 *    命令行要敲 `demo demo task list`；所以要传 `apiDef.demo`，或者用 `cliRootPath` 裁掉那层。
 */
import { z } from 'zod';
import { ChannelServerBinding, ChannelClientBinding, RpcSchema, defineService } from '../../../src/index';
import { createMemTransportPair } from '../../../test/helpers';
import { CliApp } from '../../../src/cli/index';

// ═══ 模块 A：task ═══
const taskRoutes = RpcSchema.group({
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
export const taskService = defineService({ name: 'demo.task', api: taskRoutes });

// ═══ 模块 B：agent ═══
const agentRoutes = RpcSchema.group({
    desc: '本地 agent',
    children: {
        list: RpcSchema.unary({
            desc: '列出会话',
            input: { running: z.boolean().optional().cliOption({ desc: '只看运行中的' }) },
            output: z.array(z.object({ taskUri: z.string(), state: z.string() })),
        }),
    },
});
export const agentService = defineService({ name: 'demo.agent', api: agentRoutes });

// ═══ 根：只做挂载，不改任何模块的 api ═══
export const apiDef = RpcSchema.group({
    children: {
        demo: RpcSchema.group({
            desc: '演示 CLI（多模块合并成一个根）',
            children: {
                task: taskRoutes,
                agent: agentRoutes,
            },
        }),
    },
});

const TASKS = [{ uri: 'projects/1/tasks/7', title: '示例任务' }];

class CliExit extends Error {
    constructor(public code: number) { super(`exit ${code}`); }
}

async function main(): Promise<void> {
    // ── 服务端：两个模块各自 bind 到自己的名字下 ──
    const [serverTx, clientTx] = createMemTransportPair();
    const server = new ChannelServerBinding(serverTx);
    taskService.bind(server, {
        list: ({ input }) => (input.state ? TASKS.filter(() => input.state === 'done') : TASKS),
        create: ({ input }) => ({ uri: `projects/1/tasks/${TASKS.length + 8}（${input.title}）` }),
    });
    agentService.bind(server, {
        list: () => [{ taskUri: 'projects/1/tasks/7', state: 'running' }],
    });

    // 已注册名一览：这就是客户端必须拼出的字符串
    console.log('服务端注册名:', server.listRegistered().sort().join(', '), '\n');

    const client = new ChannelClientBinding(clientTx);
    const run = async (argv: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        let code = 0;
        try {
            await new CliApp({
                name: 'demo',
                version: '1.0.0',
                // 坑③：传 apiDef.demo（根下面的那棵），命令段就是 `task list`
                router: apiDef.demo,
                // 坑①：客户端前缀必须与服务端注册名的前半段逐字相同
                rpcPrefix: 'demo.',
                transport: client,
                out: (l) => void out.push(l),
                err: (l) => void err.push(l),
                exit: (c: number): never => { code = c; throw new CliExit(c); },
            }).parse(argv);
        } catch (e) {
            if (!(e instanceof CliExit)) throw e;
        }
        return { code, text: out.join('\n'), errText: err.join('\n') };
    };

    console.log('$ demo --help（坑②：根层不可执行，应是帮助）');
    console.log((await run(['--help'])).text, '\n');

    console.log('$ demo task list --json');
    console.log((await run(['task', 'list', '--json'])).text, '\n');

    console.log('$ demo task create "写文档"');
    console.log((await run(['task', 'create', '写文档'])).text, '\n');

    console.log('$ demo agent list');
    console.log((await run(['agent', 'list'])).text, '\n');

    // ── 坑③ 的反例：传整棵 apiDef，命令就多一层 `demo` ──
    // （cliRootPath 可以裁掉，见 04-root-pitfalls）
    console.log('坑③ 反例：router 传整棵 apiDef 时，命令要敲 `demo demo task list`');
    console.log('       —— 根那层被当成命令段了。传 apiDef.demo 即解决。');

    client.dispose();
}

void main();
