/**
 * RPC V2 设计验证测试 — meta/handle 分离 + zod 强类型 client
 *
 * 对比 v1（createClient 从 router 结构推导类型）：
 *   - meta（zod schema）单独定义，不掺 call
 *   - handle 通过 .on() 绑定到 meta 对象
 *   - client 类型直接由 meta 的 zod schema 用 z.infer 推导，不依赖泛型参数
 */

import type { Transport } from '../src/core/types';
import { z } from 'zod';
import { RpcSchema, RpcServer, createTypedClient, ChannelRawClient, ChannelRawServer } from '../src/index';

// ═══════════════════════════════════════════════════
//  meta 定义（纯 zod，无 call）
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
  nums: RpcSchema.serverStream({
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
//  in-memory Transport（复用，精简版）
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
//  测试主体
// ═══════════════════════════════════════════════════

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, msg: string) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.error(`  ❌ ${msg}`); process.exit(1); }
  }

  // ── 1. handle 分离绑定 ─────────────────────
  // meta 对象不掺 call，handler 通过 .on() 单独绑定
  console.log('\n── meta/handle 分离 ──');

  const [txSrv, txCli] = createMemTransportPair();
  const rpcServer = new RpcServer({ router: apiDef });
  rpcServer.registerInto(new ChannelRawServer(txSrv));

  // 每个 meta 对象单独绑 handler
  rpcServer.on(apiDef.math.add, async ({ input }) => input.a + input.b);
  rpcServer.on(apiDef.greet, async ({ input }) => `Hello, ${input.name}!`);
  rpcServer.on(apiDef.nums, async function* ({ input }) {
    for (let i = 1; i <= input.n; i++) {
      await new Promise(r => setImmediate(r));
      yield i;
    }
  });
  rpcServer.on(apiDef.upload, async ({ input, stream }) => {
    let sum = 0;
    for await (const v of stream) sum += v;
    return { tag: input.tag, sum };
  });
  rpcServer.on(apiDef.chat, async function* ({ input, stream }) {
    for await (const msg of stream) yield `[${input.room}] ${msg}`;
  });

  console.log('  handlers 已绑定（.on() 逐个挂载）');

  // ── 2. client 从 meta 的 zod 生成强类型 ─────
  console.log('\n── zod 强类型 client ──');

  const cli = createTypedClient(new ChannelRawClient(txCli), apiDef);

  // 类型检查（编译期验证，z.infer 从 zod 推导）
  const r1: number = await cli.math.add({ a: 3, b: 4 });
  assert(r1 === 7, `add(3,4) = ${r1} (number)`);

  const r2: string = await cli.greet({ name: 'World' });
  assert(r2 === 'Hello, World!', `greet = ${r2} (string)`);

  // server-stream
  const h = await cli.nums({ n: 3 });
  const nums: number[] = [];
  for await (const v of h) nums.push(v);
  assert(JSON.stringify(nums) === '[1,2,3]', `nums = ${JSON.stringify(nums)}`);

  // client-stream（AsyncIterable）
  async function* uploadGen() { yield 10; yield 20; yield 30; }
  const u = await cli.upload({ tag: 'x' }, uploadGen());
  assert(u.tag === 'x' && u.sum === 60, `upload = ${JSON.stringify(u)}`);

  // bidi-stream
  async function* chatGen() { yield 'hello'; yield 'bye'; }
  const replies = await cli.chat({ room: 'test' }, chatGen());
  const chats: string[] = [];
  for await (const r of replies) chats.push(r);
  assert(JSON.stringify(chats) === '["[test] hello","[test] bye"]', `chat = ${JSON.stringify(chats)}`);

  // ── 3. runtime zod 输入校验 ─────────────────
  console.log('\n── runtime zod 校验 ──');

  try {
    await cli.math.add({ a: 'not-a-number' as any, b: 4 });
    assert(false, 'zod 应拒绝非 number 输入');
  } catch {
    assert(true, 'zod 拒绝 string 输入到 number 字段');
  }

  // ── 结果 ─────────────────────────────────
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });

