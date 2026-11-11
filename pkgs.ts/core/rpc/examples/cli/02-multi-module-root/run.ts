/**
 * 02-multi-module-root —— **多个模块合并成同一个根命令**（diy 的实际形态）
 *
 *   npx tsx pkgs.ts/core/rpc/examples/cli/02-multi-module-root/run.ts
 *
 *   demo task list          ← task 模块
 *   demo task create "标题"
 *   demo agent list         ← agent 模块
 *
 * ## 模型只有两层
 *
 * ```
 * <app> . <模块层> . <方法>
 *  demo     task      list
 * ```
 *
 * · **模块层由模块自己写**（`children: { task: … }`）—— 身份跟着模块走
 * · **app 前缀由使用方给**（`server.use({ prefix: 'demo' })`）—— 换 app 不改模块：
 *   同一份 `taskApi` 挂到 `diyvideo` 下就是 `diyvideo.task.list`
 *
 * 不做「任意命令树 merge」：那会让某个方法的线上名取决于谁的合并顺序，冲突只能运行时撞车。
 */
import { z } from 'zod';
import { RpcSchema } from '../../../src/core/rpc';
import { CliApp } from '../../../src/cli/index';

// ═══ 模块 A：task（自己带 `task` 层） ═══
export const taskApi = RpcSchema.group({
  children: {
    task: RpcSchema.group({
      desc: '任务管理',
      children: {
        list: RpcSchema.unary({
          desc: '列出任务',
          input: {
            state: z.enum(['pending', 'done']).optional().cliOption({ desc: '按状态过滤' }),
          },
          output: z.array(z.object({ uri: z.string(), title: z.string() })),
        }),
        create: RpcSchema.unary({
          desc: '创建任务',
          input: { title: z.string().cliArg({ desc: '任务标题' }) },
          output: z.object({ uri: z.string() }),
        }),
      },
    }),
  },
});

// ═══ 模块 B：agent（自己带 `agent` 层） ═══
export const agentApi = RpcSchema.group({
  children: {
    agent: RpcSchema.group({
      desc: '本地 agent',
      children: {
        list: RpcSchema.unary({
          desc: '列出会话',
          input: { running: z.boolean().optional().cliOption({ desc: '只看运行中的' }) },
          output: z.array(z.object({ taskUri: z.string(), state: z.string() })),
        }),
      },
    }),
  },
});

const TASKS = [{ uri: 'projects/1/tasks/7', title: '示例任务' }];

async function main(): Promise<void> {
  // 一句话：起 mem 通道 + 服务端 + 各模块客户端，返回可运行的 CLI
  const cli = CliApp.inProcess({
    name: 'demo',
    version: '1.0.0',
    scopes: [
      {
        prefix: 'demo',
        api: taskApi,
        handlers: {
          task: {
            list: ({ input }: any) =>
              input.state ? TASKS.filter(() => input.state === 'done') : TASKS,
            create: ({ input }: any) => ({
              uri: `projects/1/tasks/${TASKS.length + 8}（${input.title}）`,
            }),
          },
        },
      },
      {
        prefix: 'demo',
        api: agentApi,
        handlers: { agent: { list: () => [{ taskUri: 'projects/1/tasks/7', state: 'running' }] } },
      },
    ],
  });

  try {
    console.log(
      '服务端注册名（app 前缀 + 模块层 + 方法）:',
      cli.listRegistered().sort().join(', '),
      '\n',
    );

    const show = async (label: string, argv: string[]) => {
      const r = await cli.run(argv);
      console.log(`$ ${label}`);
      console.log(r.out.join('\n') || r.err.join('\n'));
      console.log();
    };

    await show('demo --help（顶层就是各模块的命令段）', ['--help']);
    await show('demo task list --json', ['task', 'list', '--json']);
    await show('demo task create "写文档"', ['task', 'create', '写文档']);
    await show('demo agent list', ['agent', 'list']);

    // ── 同一个模块挂到另一个 app：只换 prefix，模块源码一行没改 ──
    console.log('同一份 taskApi 换到 app "diyvideo"：');
    const other = CliApp.inProcess({
      name: 'diyvideo',
      scopes: [
        {
          prefix: 'diyvideo',
          api: taskApi,
          handlers: { task: { list: () => TASKS, create: () => ({ uri: '' }) } },
        },
      ],
    });
    console.log('  注册名:', other.listRegistered().sort().join(', '));
    console.log('  命令段不变:', (await other.run(['task', 'list', '--json'])).out.join(''));
    other.dispose();
  } finally {
    cli.dispose();
  }
}

void main();
