/**
 * 01-single-module —— 最小可跑：一个 defineService → 一棵命令树
 *
 *   npx tsx pkgs.ts/core/rpc/examples/cli/01-single-module/run.ts
 *
 * 跑完能看到三次真实调用（不是打印 mock）：
 *   fact list --limit 2 --json
 *   fact list --help
 *   fact get missing            ← 退义码 1（按名取实体查不到）
 *
 * 关键点：
 *   · `defineService({ name: "demo" })` 决定**服务端注册名**（demo.fact.list）
 *   · CliApp 的 `rpcPrefix: "demo."` 决定**客户端调用名**，两边必须一致
 *   · 命令段 = group children 路径，参数名 = zod 字段名
 */
import { z } from 'zod';
import { ChannelServerBinding, ChannelClientBinding } from '../../../src/index';
import { RpcSchema, defineService } from '../../../src/index';
import { createMemTransportPair } from '../../../test/helpers';
import { CliApp } from '../../../src/cli/index';

// ── 1. api：一棵 group 树，每个叶子是一条命令 ──
const factRoutes = RpcSchema.group({
  desc: '事实库',
  children: {
    list: RpcSchema.unary({
      desc: '列出全部事实',
      input: {
        limit: z.number().int().positive().optional().cliOption({ desc: '最多返回几条' }),
      },
      output: z.array(z.object({ claim: z.string(), value: z.string() })),
    }),
    get: RpcSchema.unary({
      desc: '按 claim 取一条事实',
      input: {
        claim: z.string().cliArg({ desc: 'claim 名，如 rule#worktree' }),
      },
      output: z.object({ claim: z.string(), value: z.string() }).nullable(),
    }),
  },
});

// name 必须覆盖命令树里的模块段：命令是 `fact list`，注册名就应是 `demo.fact` + `.list`
export const factService = defineService({ name: 'demo.fact', api: factRoutes });

/**
 * 根：CliApp 拿到的必须是「根 group」。传 `factRoutes` 本身也行 —— 但它会被当成根，
 * 命令就变成 `list` / `get`（少了 `fact` 那层）。想让命令是 `fact list`，就包一层。
 */
const rootRoutes = RpcSchema.group({ children: { fact: factRoutes } });

/** 真数据换成一个内存表，重点看 CLI 行为 */
const FACTS = [
  { claim: 'rule#worktree', value: '改代码先开 worktree' },
  { claim: 'rule#gpg', value: 'git 操作一律签名' },
];

class CliExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function main(): Promise<void> {
  // ── 2. 服务端：同一份 schema 挂 handlers ──
  const [serverTx, clientTx] = createMemTransportPair();
  factService.bind(new ChannelServerBinding(serverTx), {
    list: ({ input }) => (input.limit ? FACTS.slice(0, input.limit) : FACTS),
    get: ({ input }) => FACTS.find((f) => f.claim === input.claim) ?? null,
  });

  // ── 3. 客户端：CliApp 吃同一棵树 ──
  const client = new ChannelClientBinding(clientTx);
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    try {
      await new CliApp({
        name: 'demo',
        version: '1.0.0',
        router: rootRoutes,
        // 服务端注册名是 `demo.fact.list`；客户端必须拼出同一个字符串
        rpcPrefix: 'demo.',
        transport: client,
        // 按名取实体查不到 ⇒ 退出码 1（`demo fact get X && ...` 不许对不存在的东西说通过）
        exitCodeOf: ({ rpcName, result }) =>
          rpcName.endsWith('.get') && result === null ? 1 : undefined,
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

  // ── 4. 三种典型用法 ──
  console.log('$ demo fact list --limit 2 --json');
  let r = await run(['fact', 'list', '--limit', '2', '--json']);
  console.log(r.text, '\n');

  console.log('$ demo fact get missing（查不到 ⇒ 退出码 1）');
  r = await run(['fact', 'get', 'missing']);
  console.log(r.text, `退出码=${r.code}`, '\n');

  console.log('$ demo fact --help（父命令：只列子命令）');
  r = await run(['fact', '--help']);
  console.log(r.text);

  client.dispose();
}

void main();
