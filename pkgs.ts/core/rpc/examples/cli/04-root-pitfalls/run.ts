/**
 * 04-root-pitfalls —— 根命令的四个坑，每个都能跑出真实报错/正确结果
 *
 *   npx tsx pkgs.ts/core/rpc/examples/cli/04-root-pitfalls/run.ts
 *
 * 这些都是 2026-11 在 diy 上真实踩过的（#463 / #467 两次回归，外加 cliRootPath 的误用），
 * 做成可跑的例子，省得下一个人再靠猜。
 *
 * ## 坑清单
 *
 * ① 忘了 `rpcPrefix`            → `Unknown method: task.list`（服务端叫 `demo.task.list`）
 * ② `rpcPrefix` 写过头          → `Unknown method: demo.task.task.list`
 * ③ 传整棵 apiDef              → 命令多一层：要敲 `demo demo task list`
 *    · 修法 A：传 apiDef.demo（推荐，显式）
 *    · 修法 B：`cliRootPath: ['demo']`（同一棵树能出两种命令视图）
 * ④ 根层被当成可执行命令        → `demo` 单独敲必须落到 help，不能发 RPC
 *
 * 为什么会这样：**命令段与调用名是两套路径**。
 *   命令段 = 你敲什么（可被 cliRootPath 裁剪）
 *   调用名 = 线上叫什么（rpcPrefix + 完整 path，永远不能裁）
 */
import { z } from 'zod';
import {
  ChannelServerBinding,
  ChannelClientBinding,
  RpcSchema,
  defineService,
} from '../../../src/index';
import { createMemTransportPair } from '../../../test/helpers';
import { CliApp } from '../../../src/cli/index';

const taskRoutes = RpcSchema.group({
  desc: '任务管理',
  children: {
    list: RpcSchema.unary({
      desc: '列出任务',
      input: {},
      output: z.array(z.object({ uri: z.string() })),
    }),
  },
});

const apiDef = RpcSchema.group({
  children: {
    demo: RpcSchema.group({ desc: '演示根', children: { task: taskRoutes } }),
  },
});

class CliExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function main(): Promise<void> {
  const [serverTx, clientTx] = createMemTransportPair();
  const server = new ChannelServerBinding(serverTx);
  server.use({
    prefix: "demo.task",
    api: taskRoutes,
    handlers: { list: () => [{ uri: "projects/1/tasks/1" }] },
  });
  console.log("服务端注册名: demo.task.list", "\n");

  const client = new ChannelClientBinding(clientTx);
  /** 每轮换一套 CliApp 配置，跑一次命令，返回输出与退出码 */
  const run = async (
    cfg: { router: any; rpcPrefix?: string; cliRootPath?: string | string[] },
    argv: string[],
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    try {
      await new CliApp({
        name: 'demo',
        version: '1.0.0',
        router: cfg.router,
        ...(cfg.rpcPrefix !== undefined ? { rpcPrefix: cfg.rpcPrefix } : {}),
        ...(cfg.cliRootPath !== undefined ? { cliRootPath: cfg.cliRootPath } : {}),
        transport: client,
        out: (l) => void out.push(l),
        err: (l) => void err.push(l),
        exit: (c: number): never => {
          code = c;
          throw new CliExit(c);
        },
      }).parse(argv);
    } catch (e) {
      if (!(e instanceof CliExit)) throw e;
    }
    return { code, text: out.join('\n'), errText: err.join('\n') };
  };

  // ── 坑①：漏 rpcPrefix ──
  console.log('坑① 漏 rpcPrefix：');
  let r = await run({ router: apiDef.demo }, ['task', 'list']);
  console.log(`  client.invoke("task.list") → 服务端只有 demo.task.list`);
  console.log(`  [stderr] ${r.errText.trim()}  退出码=${r.code}\n`);

  // ── 坑②：前缀写过头 ──
  console.log('坑② rpcPrefix 写过头（demo.task.）：');
  r = await run({ router: apiDef.demo, rpcPrefix: 'demo.task.' }, ['task', 'list']);
  console.log(`  [stderr] ${r.errText.trim()}  退出码=${r.code}\n`);

  // ── 正确姿势 ──
  console.log('✅ rpcPrefix = "demo."（= service.name 的点号前缀）：');
  r = await run({ router: apiDef.demo, rpcPrefix: 'demo.' }, ['task', 'list', '--json']);
  console.log(`  ${r.text}\n`);

  // ── 坑③：传整棵 apiDef ──
  console.log('坑③ 传整棵 apiDef，命令多一层：');
  const helpWhole = (await run({ router: apiDef, rpcPrefix: 'demo.' }, ['--help'])).text;
  console.log(
    `  $ demo --help 顶层可见: ${helpWhole
      .split('\n')
      .filter((l) => l.startsWith('  '))
      .map((l) => l.trim().split(/\s+/)[0])
      .join(', ')}`,
  );
  console.log(
    `  $ demo task list   →  ${(await run({ router: apiDef, rpcPrefix: 'demo.' }, ['task', 'list'])).code === 0 ? '能跑' : '跑不了（根那层占了命令段）'}`,
  );
  // 传整棵时 path 已经是 `demo.task.list`，再加 rpcPrefix `demo.` 就成了 demo.demo.task.list
  const wholeWithPrefix = await run({ router: apiDef, rpcPrefix: 'demo.' }, [
    'demo',
    'task',
    'list',
  ]);
  console.log(
    `  $ demo demo task list（rpcPrefix 仍是 "demo."）→ ${wholeWithPrefix.code === 0 ? '能跑' : '跑不了：' + wholeWithPrefix.errText.trim()}`,
  );
  const wholeNoPrefix = await run({ router: apiDef, rpcPrefix: '' }, ['demo', 'task', 'list']);
  console.log(
    `  同上，但 rpcPrefix 改成 ""（path 已含 demo 段）→ ${wholeNoPrefix.code === 0 ? '能跑：' + wholeNoPrefix.text.trim() : '跑不了'}\n`,
  );

  // ── 坑③ 修法 B：cliRootPath（命令视图裁剪，调用名不变） ──
  console.log('坑③ 修法 B：cliRootPath: ["demo"]（命令段裁掉，rpcName 仍是 demo.task.list）：');
  // 命令段裁掉 `demo`，但 rpcName 用的是完整 path（demo.task.list）→ rpcPrefix 必须为空
  r = await run({ router: apiDef, rpcPrefix: '', cliRootPath: ['demo'] }, [
    'task',
    'list',
    '--json',
  ]);
  console.log(`  ${r.text || r.errText}\n`);

  // ── 坑④：根层不可执行 ──
  console.log('坑④ 单独敲根命令：');
  r = await run({ router: apiDef.demo, rpcPrefix: 'demo.' }, []);
  console.log(`  退出码=${r.code}（0，且不发 RPC —— 打的是 help）`);
  console.log(`  首行: ${r.text.split('\n')[0]}`);

  client.dispose();
}

void main();
