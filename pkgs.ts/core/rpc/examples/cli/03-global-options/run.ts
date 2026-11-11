/**
 * 03-global-options —— 全局选项（进程级 flag）
 *
 *   npx tsx pkgs.ts/core/rpc/examples/cli/03-global-options/run.ts
 *
 * 全局选项与命令参数是**两层东西**：
 *   · 命令参数（zod input）→ 进 RPC，服务端看得到
 *   · 全局选项（globalOptions）→ 只在本进程消费，服务端看不到
 *
 * 本例子演示四件事：
 *   1. 声明与 procedure input 同一套写法（zod + `.cliOption()`），不引入第二套 DSL
 *   2. 位置自由：`--json task list` ≡ `task list --json`
 *   3. help 与解析同源（声明了必然出现在 Options 段）
 *   4. 值的类型由 zod 推导：`color` 只能取 auto/always/never，非法值在解析期报错
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
      input: { limit: z.number().optional().cliOption({ desc: '最多几条' }) },
      output: z.array(z.object({ uri: z.string() })),
    }),
  },
});
const taskService = defineService({ name: 'demo.task', api: taskRoutes });

/** 根 group：命令是 `task list`（传 taskRoutes 本身会变成 `list`） */
const rootRoutes = RpcSchema.group({ children: { task: taskRoutes } });

/** 全局选项表：字段名 = 值的 key，`.cliOption()` 定长短名与说明 */
const globalOptions = z.object({
  json: z.boolean().default(false).cliOption({ short: 'j', desc: '以 JSON 输出（脚本消费）' }),
  color: z.enum(['auto', 'always', 'never']).default('auto').cliOption({ desc: '着色策略' }),
  cwd: z.string().optional().cliOption({ short: 'C', desc: '以该目录为工作目录' }),
});

class CliExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function main(): Promise<void> {
  const [serverTx, clientTx] = createMemTransportPair();
  taskService.bind(new ChannelServerBinding(serverTx), {
    list: ({ input }) =>
      Array.from({ length: input.limit ?? 2 }, (_, i) => ({ uri: `projects/1/tasks/${i + 1}` })),
  });
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
        rpcPrefix: 'demo.',
        transport: client,
        globalOptions,
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

  console.log('$ demo --help（全局选项与解析同源，所以一定出现在这里）');
  console.log((await run(['--help'])).text, '\n');

  console.log('$ demo --json task list --limit 3   （前置）');
  console.log((await run(['--json', 'task', 'list', '--limit', '3'])).text, '\n');

  console.log('$ demo task list --limit 3 -j       （后置 + 短名）');
  console.log((await run(['task', 'list', '--limit', '3', '-j'])).text, '\n');

  console.log('$ demo task list --color rainbow     （枚举非法 ⇒ 退出码 2）');
  const bad = await run(['task', 'list', '--color', 'rainbow']);
  console.log(`[stderr] ${bad.errText}`, `退出码=${bad.code}`, '\n');

  console.log('⚠️ 全局选项的值服务端看不到：handler 里没有 `color` —— 它只在客户端消费。');
  console.log('   想让服务端知道的环境事实（cwd/版本/traceId）走调用级 meta，不走全局选项。');

  client.dispose();
}

void main();
