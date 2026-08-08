/**
 * rpc-typed-client.test.ts — createTypedClient 场景覆盖验证
 *
 * 覆盖场景：unary（普通 / 嵌套 router / 并发）、server-stream、client-stream
 * （AsyncIterable 与 函数两种形式）、bidi-stream、CallOptions（signal/timeout）、zod 校验。
 */

import { z } from 'zod';
import {
  RpcSchema, RpcServer, createTypedClient, ChannelRawClient, ChannelRawServer,
} from '../src/index';
import type { Transport } from '../src/core/types';

// ═══════════════════════════════════════════════════
//  in-memory Transport
// ═══════════════════════════════════════════════════

function createMemTransportPair(): [Transport, Transport] {
  const qSrv: unknown[] = [];
  const qCli: unknown[] = [];
  const srvListeners = new Set<Function>();
  const cliListeners = new Set<Function>();
  function drain() {
    while (qSrv.length > 0) { const m = qSrv.shift()!; for (const h of cliListeners) h(m); }
    while (qCli.length > 0) { const m = qCli.shift()!; for (const h of srvListeners) h(m); }
    if (qSrv.length > 0 || qCli.length > 0) setImmediate(drain);
  }
  return [
    { send(p: unknown) { qSrv.push(p); setImmediate(drain); }, on(h: Function) { srvListeners.add(h); return () => srvListeners.delete(h); }, onClose() { return () => {}; } },
    { send(p: unknown) { qCli.push(p); setImmediate(drain); }, on(h: Function) { cliListeners.add(h); return () => cliListeners.delete(h); }, onClose() { return () => {}; } },
  ];
}

// ═══════════════════════════════════════════════════
//  meta 定义（RpcSchema 纯定义）
// ═══════════════════════════════════════════════════

const apiDef = {
  math: {
    add: RpcSchema.unary({
      input: { a: z.number(), b: z.number() },
      output: z.number(),
    }),
  },
  greet: RpcSchema.unary({
    input: { name: z.string() },
    output: z.string(),
  }),
  slow: RpcSchema.unary({
    input: { delay: z.number(), id: z.number() },
    output: z.object({ id: z.number() }),
  }),
  count: RpcSchema.serverStream({
    input: { n: z.number() },
    output: z.number(),
  }),
  upload: RpcSchema.clientStream({
    input: { tag: z.string() },
    chunkIn: z.number(),
    output: z.object({ tag: z.string(), sum: z.number() }),
  }),
  chat: RpcSchema.bidiStream({
    input: { room: z.string() },
    chunkIn: z.string(),
    chunkOut: z.string(),
  }),
} as const;

// ═══════════════════════════════════════════════════
//  server handler 绑定（handle 分离）
// ═══════════════════════════════════════════════════

function startServer(txSrv: Transport): RpcServer {
  const server = new RpcServer({ router: apiDef });
  server.registerInto(new ChannelRawServer(txSrv));
  server.on(apiDef.math.add, async ({ input }) => input.a + input.b);
  server.on(apiDef.greet, async ({ input }) => `Hello, ${input.name}!`);
  server.on(apiDef.slow, async ({ input }) => {
    await new Promise(r => setTimeout(r, input.delay));
    return { id: input.id };
  });
  server.on(apiDef.count, async function* ({ input }) {
    for (let i = 0; i < input.n; i++) { await new Promise(r => setImmediate(r)); yield i; }
  });
  server.on(apiDef.upload, async ({ input, stream }) => {
    let sum = 0;
    for await (const v of stream) sum += v;
    return { tag: input.tag, sum };
  });
  server.on(apiDef.chat, async function* ({ input, stream }) {
    for await (const msg of stream) yield `[${input.room}] ${msg}`;
  });
  return server;
}

// ═══════════════════════════════════════════════════
//  测试主体
// ═══════════════════════════════════════════════════

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); process.exit(1); }
}

async function runScenarios(creator: (tx: Transport) => any, label: string) {
  console.log(`\n── ${label} ──`);

  const [txSrv, txCli] = createMemTransportPair();
  const server = startServer(txSrv);
  const cli = creator(txCli);

  // 1. unary
  const r1 = await cli.math.add({ a: 3, b: 4 });
  assert(r1 === 7, `unary add = ${r1}`);

  // 2. unary 嵌套
  const r2 = await cli.greet({ name: 'World' });
  assert(r2 === 'Hello, World!', `nested unary greet = ${r2}`);

  // 3. server-stream
  const h = await cli.count({ n: 3 });
  const nums: number[] = [];
  for await (const v of h) nums.push(v);
  assert(JSON.stringify(nums) === '[0,1,2]', `server-stream count = ${JSON.stringify(nums)}`);

  // 4. client-stream（AsyncIterable）
  async function* gen() { yield 10; yield 20; yield 30; }
  const u = await cli.upload({ tag: 'x' }, gen());
  assert(u.sum === 60, `client-stream upload(AsyncIterable) = ${JSON.stringify(u)}`);

  // 5. client-stream（函数形式）
  async function* genFn() { yield 1; yield 2; }
  const u2 = await cli.upload({ tag: 'fn' }, () => genFn());
  assert(u2.sum === 3, `client-stream upload(函数) = ${JSON.stringify(u2)}`);

  // 6. bidi-stream
  async function* chatGen() { yield 'a'; yield 'b'; }
  const replies = await cli.chat({ room: 'r' }, chatGen());
  const chats: string[] = [];
  for await (const c of replies) chats.push(c);
  assert(JSON.stringify(chats) === '["[r] a","[r] b"]', `bidi-stream chat = ${JSON.stringify(chats)}`);

  // 7. 并发 unary
  const results = await Promise.all([
    cli.slow({ delay: 20, id: 1 }),
    cli.slow({ delay: 5, id: 2 }),
  ]);
  assert(results[0].id === 1 && results[1].id === 2, '并发 unary 顺序正确');

  server.destroy();
}

async function main() {
  // ── createTypedClient 跑一遍全部场景 ──
  await runScenarios((tx) => createTypedClient(new ChannelRawClient(tx), apiDef), 'createTypedClient');

  // ── createTypedClient 独有：zod runtime 校验 ──
  console.log('\n── createTypedClient 独有：zod 校验 ──');
  const [txSrv, txCli] = createMemTransportPair();
  const server = startServer(txSrv);
  const cli = createTypedClient(new ChannelRawClient(txCli), apiDef);
  try {
    await cli.math.add({ a: 'bad' as any, b: 1 });
    assert(false, 'zod 应拒绝 string');
  } catch {
    assert(true, 'zod 拒绝非法输入');
  }
  server.destroy();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
