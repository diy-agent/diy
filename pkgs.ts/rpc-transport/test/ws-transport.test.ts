/**
 * ws-transport.test.ts — WebSocket Transport 多路复用测试
 */

import { WebSocketServer, WebSocket } from 'ws';
import { RpcImpl, router, RpcServer, createClient } from '@diy/rpc';
import { WsTransport } from '../src/websocket';
import { z } from 'zod';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const app = router({
  ping: RpcImpl.unary({
    input: { msg: z.string() },
    output: z.string(),
    call: ({ input }) => `pong: ${input.msg}`,
  }),
  add: RpcImpl.unary({
    input: { a: z.number(), b: z.number() },
    output: z.number(),
    call: ({ input }) => input.a + input.b,
  }),
  slow: RpcImpl.unary({
    input: { delay: z.number(), id: z.number() },
    output: z.object({ id: z.number() }),
    call: async ({ input }) => {
      await sleep(input.delay);
      return { id: input.id };
    },
  }),
  count: RpcImpl.serverStream({
    input: { n: z.number() },
    output: z.number(),
    call: async function* ({ input }) {
      for (let i = 0; i < input.n; i++) {
        await sleep(5);
        yield i;
      }
    },
  }),
});

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, msg: string) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.error(`  ❌ ${msg}`); process.exit(1); }
  }

  const PORT = 18923 + Math.floor(Math.random() * 1000);

  const wss = new WebSocketServer({ port: PORT });
  await new Promise<void>(resolve => wss.once('listening', resolve));

  wss.on('connection', (ws) => {
    const transport = new WsTransport(ws);
    new RpcServer({ router: app, transport });
  });

  function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const ready = new Promise<void>(resolve => ws.once('open', () => resolve()));
    return { ws, ready };
  }

  console.log('\n── Unary ──');
  {
    const { ws, ready } = connect();
    await ready;
    const transport = new WsTransport(ws);
    const rpcClient = createClient(transport, app);

    const p = await rpcClient.ping({ msg: 'hello' });
    assert(p === 'pong: hello', `ping = ${JSON.stringify(p)}`);

    const a = await rpcClient.add({ a: 3, b: 4 });
    assert(a === 7, `add = ${a}`);

    ws.close();
  }

  console.log('\n── Server-Stream ──');
  {
    const { ws, ready } = connect();
    await ready;
    const transport = new WsTransport(ws);
    const rpcClient = createClient(transport, app);

    const handle = await rpcClient.count({ n: 3 });
    const results: number[] = [];
    for await (const v of handle) results.push(v);
    assert(JSON.stringify(results) === '[0,1,2]', `count = ${JSON.stringify(results)}`);

    ws.close();
  }

  console.log('\n── Multiplex — concurrent unary ──');
  {
    const { ws, ready } = connect();
    await ready;
    const transport = new WsTransport(ws);
    const rpcClient = createClient(transport, app);

    const results = await Promise.all([
      rpcClient.slow({ delay: 30, id: 1 }),
      rpcClient.slow({ delay: 10, id: 2 }),
      rpcClient.slow({ delay: 20, id: 3 }),
    ]);
    assert(results[0].id === 1, `first = ${results[0].id}`);
    assert(results[1].id === 2, `second = ${results[1].id}`);
    assert(results[2].id === 3, `third = ${results[2].id}`);

    ws.close();
  }

  console.log('\n── Multiplex — unary + stream ──');
  {
    const { ws, ready } = connect();
    await ready;
    const transport = new WsTransport(ws);
    const rpcClient = createClient(transport, app);

    const [pingResult, streamHandle] = await Promise.all([
      rpcClient.ping({ msg: 'concurrent' }),
      rpcClient.count({ n: 5 }),
    ]);
    assert(pingResult === 'pong: concurrent', `ping = ${pingResult}`);

    const nums: number[] = [];
    for await (const v of streamHandle) nums.push(v);
    assert(JSON.stringify(nums) === '[0,1,2,3,4]', `count = ${JSON.stringify(nums)}`);

    ws.close();
  }

  console.log('\n── Two connections ──');
  {
    const c1 = connect();
    const c2 = connect();
    await Promise.all([c1.ready, c2.ready]);

    const rpc1 = createClient(new WsTransport(c1.ws), app);
    const rpc2 = createClient(new WsTransport(c2.ws), app);

    const [r1, r2] = await Promise.all([
      rpc1.ping({ msg: 'from 1' }),
      rpc2.ping({ msg: 'from 2' }),
    ]);
    assert(r1 === 'pong: from 1', `rpc1 = ${r1}`);
    assert(r2 === 'pong: from 2', `rpc2 = ${r2}`);

    c1.ws.close();
    c2.ws.close();
  }

  wss.close();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
