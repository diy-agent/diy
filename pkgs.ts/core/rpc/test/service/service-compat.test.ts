/**
 * service-compat.test.ts —— `defineService` 的兼容层（2026-11 保留，新代码用 scope.ts）。
 *
 * 为什么单独钉：它是**跨仓契约**（dev 仓的 dev-ref / dev-fs 在用）。
 * 删掉它会让外部消费方在编译期就炸（`has no exported member 'defineService'`）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ChannelClientBinding,
  ChannelServerBinding,
  createMemTransportPair,
  defineService,
  RpcSchema,
} from '../../src/core/index.js';

const api = RpcSchema.group({
  desc: '测试用 ref 模块',
  children: {
    ref: RpcSchema.group({
      children: {
        add: RpcSchema.unary({ input: { url: z.string() }, output: z.string() }),
      },
    }),
  },
});

const service = defineService({ name: 'diy.dev.ref', api });

describe('defineService（兼容层）', () => {
  it('bind 注册成 <name>.<树内 path>；use 用同一前缀调通', async () => {
    const { serverTx, clientTx } = createMemTransportPair();
    const server = new ChannelServerBinding(serverTx);
    service.bind(server, {
      ref: {
        add: async ({ input }) => `added:${input.url}`,
      },
    });

    expect(server.listRegistered()).toEqual(['diy.dev.ref.ref.add']);

    const client = new ChannelClientBinding(clientTx);
    const scoped = service.use(client);
    expect(await scoped.ref.add({ url: 'git@x/y' })).toBe('added:git@x/y');
  });

  it('缺 handler 时在 bind 期就抛，不留到运行期 Unknown method', () => {
    const { serverTx } = createMemTransportPair();
    const server = new ChannelServerBinding(serverTx);
    expect(() => service.bind(server, {} as never)).toThrow(/缺少 handler/);
  });
});
