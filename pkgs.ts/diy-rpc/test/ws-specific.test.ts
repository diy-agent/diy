/**
 * ws-specific.test.ts — WebSocket transport 协议特有行为
 *
 * 四流模式已在 binding.test.ts 参数化覆盖（ws harness）。这里只测 ws 独有：单连接
 * 多路复用（并发 unary、unary+stream 同连）、以及两条独立连接的隔离。
 */
import { describe, it, expect } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { RpcSchema, createTypedClient, router, ChannelClientBinding, ChannelServerBinding } from '../src/index';
import { WsTransport } from '../src/transport/ws';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = router({
  ping: RpcSchema.unary({ input: { msg: z.string() }, output: z.string() }),
  slow: RpcSchema.unary({ input: { delay: z.number(), id: z.number() }, output: z.object({ id: z.number() }) }),
  count: RpcSchema.serverStream({ input: { n: z.number() }, output: z.number() }),
});

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((r) => ws.once('open', () => r(ws)));
}

describe('ws-transport 协议特有', () => {
  it('单连接多路复用：并发 unary、unary+stream、两连接隔离', async () => {
    const port = 18923 + Math.floor(Math.random() * 1000);
    const wss = new WebSocketServer({ port });
    await new Promise<void>((r) => wss.once('listening', () => r()));

    wss.on('connection', (ws) => {
      const server = new ChannelServerBinding(new WsTransport(ws));
      server.onUnary(api.ping, async ({ input }) => `pong: ${input.msg}`);
      server.onUnary(api.slow, async ({ input }) => { await sleep(input.delay); return { id: input.id }; });
      server.onServerStream(api.count, async function* ({ input }) {
        for (let i = 0; i < input.n; i++) { await sleep(5); yield i; }
      });
    });

    try {
      // 1. 单连接：并发 unary 多路复用
      const ws = await connect(`ws://127.0.0.1:${port}`);
      const cli = createTypedClient(new ChannelClientBinding(new WsTransport(ws)), api);
      const results = await Promise.all([
        cli.slow({ delay: 30, id: 1 }),
        cli.slow({ delay: 10, id: 2 }),
        cli.slow({ delay: 20, id: 3 }),
      ]);
      expect(results.map((r) => r.id)).toEqual([1, 2, 3]);

      // 2. 单连接：unary + stream 同连并发
      const [pingResult, streamHandle] = await Promise.all([
        cli.ping({ msg: 'concurrent' }),
        cli.count({ n: 5 }),
      ]);
      expect(pingResult).toBe('pong: concurrent');
      const nums: number[] = [];
      for await (const v of streamHandle) nums.push(v);
      expect(nums).toEqual([0, 1, 2, 3, 4]);
      ws.close();

      // 3. 两条独立连接隔离
      const ws1 = await connect(`ws://127.0.0.1:${port}`);
      const ws2 = await connect(`ws://127.0.0.1:${port}`);
      const cli1 = createTypedClient(new ChannelClientBinding(new WsTransport(ws1)), api);
      const cli2 = createTypedClient(new ChannelClientBinding(new WsTransport(ws2)), api);
      const [r1, r2] = await Promise.all([
        cli1.ping({ msg: 'from 1' }),
        cli2.ping({ msg: 'from 2' }),
      ]);
      expect(r1).toBe('pong: from 1');
      expect(r2).toBe('pong: from 2');
      ws1.close();
      ws2.close();
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
