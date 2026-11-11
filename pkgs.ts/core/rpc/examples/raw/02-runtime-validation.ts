/**
 * 02-runtime-validation — wire 形状由 zod 把守，调用方传错会当场拒
 *
 * 类型层只有编译期；**运行时**要怎么挡？答：schema.parse 在 invoke 前跑。
 */
import { z } from 'zod';
import {
  RpcSchema,
  ChannelServerBinding,
  ChannelClientBinding,
  createScopedClient,
} from '../../src/index';
import { createMemTransportPair } from '../../test/helpers';

const routes = RpcSchema.group({
  children: {
    echo: RpcSchema.unary({
      input: { name: z.string().min(1), age: z.number().int().positive() },
      output: z.string(),
    }),
  },
});

async function main(): Promise<void> {
  const [txs, txc] = createMemTransportPair();
  new ChannelServerBinding(txs).use({
    prefix: 'demo',
    api: routes,
    handlers: {
      echo: ({ input }) => `${input.name}(${input.age})`,
    },
  });
  const c = createScopedClient({
    api: routes,
    client: new ChannelClientBinding(txc),
    prefix: 'demo',
  });

  console.log('✓ 合法:', await c.echo({ name: 'amy', age: 30 }));

  // 下面这些在**运行时**被 zod 拦下（类型层也会报，但外部输入只有运行时才挡得住）
  for (const bad of [
    { name: '', age: 30 },
    { name: 'amy', age: -1 },
    { name: 'amy', age: 1.5 },
  ]) {
    try {
      await c.echo(bad);
      console.log('✗ 不该通过:', bad);
    } catch (e) {
      console.log('✓ 拦下:', JSON.stringify(bad), '→', (e as Error).message.split('\n')[0]);
    }
  }
}

void main();
