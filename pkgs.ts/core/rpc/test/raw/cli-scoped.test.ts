/**
 * cli-scoped.test.ts — 「模块自带模块层 + app 前缀由宿主给」+ `CliApp.inProcess`
 *
 * 模型只有两层：
 *
 *   <app>. <模块层> . <方法>
 *    diy    task       list
 *
 * · 模块层由**模块自己**写进 api（`children: { task: … }`）—— 身份跟着模块走
 * · app 前缀由**使用方**给（`server.use({ prefix: 'diy' })`）—— 换个 app 不用改模块
 *
 * 验：线上名拼接、命令树来自模块层、多模块共存、同模块挂两个 app、命令段冲突在构造期报错。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RpcSchema } from '../../src/core/rpc.js';
import { CliApp } from '../../src/cli/index.js';

// ── 模块 A：task（自己带 `task` 层） ──
const taskApi = RpcSchema.group({
  children: {
    task: RpcSchema.group({
      desc: '任务管理',
      children: {
        list: RpcSchema.unary({
          desc: '列出任务',
          input: {
            state: z.enum(['pending', 'done']).optional().cliOption({ desc: '按状态过滤' }),
          },
          output: z.array(z.object({ uri: z.string(), state: z.string() })),
        }),
        create: RpcSchema.unary({
          desc: '创建任务',
          input: { title: z.string().cliArg({ desc: '标题' }) },
          output: z.object({ uri: z.string() }),
        }),
      },
    }),
  },
});

// ── 模块 B：agent（自己带 `agent` 层） ──
const agentApi = RpcSchema.group({
  children: {
    agent: RpcSchema.group({
      desc: '本地 agent',
      children: {
        list: RpcSchema.unary({
          desc: '列出会话',
          input: {},
          output: z.array(z.object({ taskUri: z.string() })),
        }),
      },
    }),
  },
});

const TASKS = [{ uri: 'projects/1/tasks/7', state: 'pending' }];

function harness(prefix = 'diy') {
  return CliApp.inProcess({
    name: prefix,
    version: '1.0.0',
    scopes: [
      {
        prefix,
        api: taskApi,
        handlers: {
          task: {
            list: ({ input }: any) =>
              input.state ? TASKS.filter((t) => t.state === input.state) : TASKS,
            create: ({ input }: any) => ({ uri: `projects/1/tasks/9（${input.title}）` }),
          },
        },
      },
      {
        prefix,
        api: agentApi,
        handlers: { agent: { list: () => [{ taskUri: 'projects/1/tasks/7' }] } },
      },
    ],
  });
}

describe('CliApp.inProcess + 模块自带模块层', () => {
  it('注册名 = app 前缀 + 模块层 + 方法', () => {
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

  it('命令段来自模块层，不是 prefix', async () => {
    const cli = harness();
    try {
      const r = await cli.run(['task', 'list', '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out.join('\n')).data).toEqual(TASKS);
    } finally {
      cli.dispose();
    }
  });

  it('多个模块平铺成一棵命令树（各自带 desc）', async () => {
    const cli = harness();
    try {
      const text = (await cli.run(['--help'])).out.join('\n');
      expect(text).toContain('task');
      expect(text).toContain('agent');
      expect(text).toContain('任务管理');
    } finally {
      cli.dispose();
    }
  });

  it('同一个模块挂到另一个 app：线上名换前缀，命令段不变', async () => {
    const cli = harness('diyvideo');
    try {
      expect(cli.listRegistered()).toContain('diyvideo.task.list');
      const r = await cli.run(['task', 'list', '--json']);
      expect(r.code).toBe(0);
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

  it('两个模块抢同一个命令段 → 构造期报错', () => {
    expect(() =>
      CliApp.inProcess({
        name: 'diy',
        scopes: [
          {
            prefix: 'diy',
            api: taskApi,
            handlers: { task: { list: () => [], create: () => ({ uri: '' }) } },
          },
          {
            prefix: 'diy',
            api: taskApi,
            handlers: { task: { list: () => [], create: () => ({ uri: '' }) } },
          },
        ],
      }),
    ).toThrow(/已注册|命令段/);
  });

  it('run(argv, { json: true }) 强制 JSON 输出（不被 parse 重算覆盖）', async () => {
    const cli = harness();
    try {
      const r = await cli.run(['task', 'list'], { json: true });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out.join('\n'))).toMatchObject({ ok: true });
    } finally {
      cli.dispose();
    }
  });

  it('全局选项与命令级选项重名 → 构造期报错（否则命令端被静默吞掉）', () => {
    const clashApi = RpcSchema.group({
      children: {
        clash: RpcSchema.group({
          children: {
            run: RpcSchema.unary({
              input: { color: z.string().optional().cliOption({ desc: '命令自己的 color' }) },
              output: z.string(),
            }),
          },
        }),
      },
    });
    expect(() =>
      CliApp.inProcess({
        name: 'diy',
        scopes: [
          {
            prefix: 'diy',
            api: clashApi,
            handlers: { clash: { run: ({ input }: any) => input.color ?? '' } },
          },
        ],
        globalOptions: z.object({ color: z.string().optional().cliOption({ desc: '全局 color' }) }),
      }),
    ).toThrow(/重名/);
  });
});
