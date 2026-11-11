/**
 * 01-basic — 最小可用：定义 → 绑定 → 调用
 *
 * 跑：`npx tsx pkgs.ts/core/rpc/examples/01-basic.ts`
 */
import { z } from 'zod';
import {
  RpcSchema,
  ChannelServerBinding,
  ChannelClientBinding,
  createScopedClient,
} from '../../src/index';
import { createMemTransportPair } from '../../test/helpers';

// ① 定义：纯 schema，没有 handler
const mathRoutes = RpcSchema.group({
  children: {
    math: RpcSchema.group({
      children: {
        add: RpcSchema.unary({
          input: { a: z.number(), b: z.number() },
          output: z.number(),
          desc: 'a + b',
        }),
      },
    }),
  },
});

async function main(): Promise<void> {
  // ② 建传输（示例用内存对；真实场景换成 http / ws / electron）
  const [txServer, txClient] = createMemTransportPair();
  const server = new ChannelServerBinding(txServer);
  const client = new ChannelClientBinding(txClient);

  // ③ 服务端：一次注册整个模块
  //    handler 收到 `{ input, signal }`，返回 T 或 Promise<T>
  server.use({
    prefix: 'demo',
    api: mathRoutes,
    handlers: {
      math: {
        add: ({ input }) => input.a + input.b,
      },
    },
  });

  // ④ 客户端：只拿这个模块
  const math = createScopedClient({ api: mathRoutes, client: client, prefix: 'demo' });
  console.log('2 + 3 =', await math.math.add({ a: 2, b: 3 }));
  //                       ^^^^^^^^^^^^^^^ 注意：`{ a, b }` 是对象，不摊平
}

void main();
