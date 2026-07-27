/**
 * http2-transport.test.ts — HTTP/2 Transport 测试
 */

import { Server, Client, rpc, router, createHandler, createClient } from '@diy/rpc';
import { createHttp2RpcServer, connectHttp2Rpc } from '../src/http2';
import { z } from 'zod';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const app = router({
  ping: rpc.unary({
    input: { msg: z.string() },
    output: z.string(),
    call: ({ input }) => `pong: ${input.msg}`,
  }),
  add: rpc.unary({
    input: { a: z.number(), b: z.number() },
    output: z.number(),
    call: ({ input }) => input.a + input.b,
  }),
  slow: rpc.unary({
    input: { delay: z.number(), id: z.number() },
    output: z.object({ id: z.number() }),
    call: async ({ input }) => {
      await sleep(input.delay);
      return { id: input.id };
    },
  }),
  count: rpc.serverStream({
    input: { n: z.number() },
    output: z.number(),
    call: async function* ({ input }) {
      for (let i = 0; i < input.n; i++) {
        await sleep(3);
        yield i;
      }
    },
  }),
  upload: rpc.clientStream({
    input: { tag: z.string() },
    chunkIn: z.number(),
    output: z.object({ tag: z.string(), sum: z.number() }),
    call: async ({ input, stream }) => {
      let sum = 0;
      for await (const v of stream) sum += v;
      return { tag: input.tag, sum };
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

  const { server, port } = createHttp2RpcServer((transport) => {
    const srv = new Server(transport);
    createHandler({ router: app, transport: srv });
  });
  server.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));

  function connect() {
    return connectHttp2Rpc(port());
  }

  console.log('\n── Unary ──');
  {
    const transport = await connect();
    const rpcClient = createClient<typeof app>(new Client(transport), app);

    const p = await rpcClient.ping({ msg: 'http2' });
    assert(p === 'pong: http2', `ping = ${JSON.stringify(p)}`);

    const a = await rpcClient.add({ a: 10, b: 20 });
    assert(a === 30, `add = ${a}`);

    transport.send('cleanup');
  }

  console.log('\n── Server-Stream ──');
  {
    const transport = await connect();
    const rpcClient = createClient<typeof app>(new Client(transport), app);

    const handle = await rpcClient.count({ n: 4 });
    const results: number[] = [];
    for await (const v of handle) results.push(v);
    assert(JSON.stringify(results) === '[0,1,2,3]', `count = ${JSON.stringify(results)}`);
  }

  console.log('\n── Client-Stream ──');
  {
    const transport = await connect();
    const rpcClient = createClient<typeof app>(new Client(transport), app);

    async function* gen() { yield 10; yield 20; yield 30; }
    const result = await rpcClient.upload({ tag: 'sum' }, gen());
    assert(result.tag === 'sum' && result.sum === 60, `upload = ${JSON.stringify(result)}`);
  }

  console.log('\n── Multiplex (concurrent unary) ──');
  {
    const transport = await connect();
    const rpcClient = createClient<typeof app>(new Client(transport), app);

    const results = await Promise.all([
      rpcClient.slow({ delay: 30, id: 1 }),
      rpcClient.slow({ delay: 10, id: 2 }),
      rpcClient.slow({ delay: 20, id: 3 }),
    ]);
    assert(results[0].id === 1, `first = ${results[0].id}`);
    assert(results[1].id === 2, `second = ${results[1].id}`);
    assert(results[2].id === 3, `third = ${results[2].id}`);
  }

  console.log('\n── Multiplex (unary + stream) ──');
  {
    const transport = await connect();
    const rpcClient = createClient<typeof app>(new Client(transport), app);

    const [pingResult, streamHandle] = await Promise.all([
      rpcClient.ping({ msg: 'mix' }),
      rpcClient.count({ n: 3 }),
    ]);
    assert(pingResult === 'pong: mix', `ping = ${pingResult}`);

    const nums: number[] = [];
    for await (const v of streamHandle) nums.push(v);
    assert(JSON.stringify(nums) === '[0,1,2]', `count = ${JSON.stringify(nums)}`);
  }

  server.close();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
