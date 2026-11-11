/**
 * 01-basic/run.ts —— 生成型的推荐写法
 *
 *   npx tsx pkgs.ts/core/rpc/examples/service/01-basic/run.ts
 */
import { ChannelServerBinding, ChannelClientBinding, createScopedClient } from '../../../src/index';
import { createMemTransportPair } from '../../../test/helpers';
import { mathRoutes } from './src/api';

async function main(): Promise<void> {
  const [txServer, txClient] = createMemTransportPair();

  // 服务端：一次注册整个模块（handler 收 `{ input, signal }`）
  new ChannelServerBinding(txServer).use({
    prefix: 'demo',
    api: mathRoutes,
    handlers: {
      math: {
        add: ({ input }) => input.a + input.b,
        version: () => '1.0.0',
      },
    },
  });

  // 客户端：只拿这个模块（前缀与 bind 同源）
  const math = createScopedClient({
    api: mathRoutes,
    client: new ChannelClientBinding(txClient),
    prefix: 'demo',
  });
  console.log('2 + 3 =', await math.math.add({ a: 2, b: 3 }));
  console.log('version =', await math.math.version({}));
}

void main();
