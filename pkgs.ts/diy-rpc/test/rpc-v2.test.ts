/**
 * RPC V2 设计验证测试
 *
 * 展示新技术四种流程模式的完整外观：
 *   1. RpcSchema 定义 — RpcSchema.unary / serverStream / ...
 *   2. handler 绑定 — RpcServer.on(metaNode, handler)
 *   3. client 调用 — createClient(transport, apiDef)
 *   4. RpcImpl 自动注册 — 构造时自动注册所有含 call 的 procedure
 */

import type { Transport } from '../src/transport/types';
import { Client } from '../src/transport/client';
import { z } from 'zod';
import {
  RpcSchema, RpcImpl, RpcServer,
  createClient,
} from '../src/index';

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

  // ── 1. Meta 定义（半完成态）───────────────────

  console.log('\n── Meta 定义 ──');

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

  // meta 对象本身可被 client import，无 call
  const greetMeta = apiDef.greet;
  // greetMeta 的 inputSchema/outputSchema/_streamMode 全部在 runtime 可用
  console.log('  meta 类型:', greetMeta._streamMode);
  console.log('  meta 输入字段:', Object.keys((greetMeta as any).inputSchema?.shape ?? {}));

  // ── 3. Server 注册 + handler 绑定 ─────────────────

  console.log('\n── Server 注册 ──');

  const [txSrv, txCli] = createMemTransportPair();
  const client = new Client(txCli);

  const rpcServer = new RpcServer({ router: apiDef, transport: txSrv });
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

  // ── 4. Client 调用 ─────────────────────────

  console.log('\n── Client 调用 ──');

  const rpcClient = createClient(client, apiDef);

  // Unary
  const r1 = await rpcClient.math.add({ a: 3, b: 4 });
  assert(r1 === 7, `add(3,4) = ${r1}`);

  const r2 = await rpcClient.greet({ name: 'World' });
  assert(r2 === 'Hello, World!', `greet = ${r2}`);

  // Server-Stream
  const h = await rpcClient.nums({ n: 3 });
  const nums: number[] = [];
  for await (const v of h) nums.push(v);
  assert(JSON.stringify(nums) === '[1,2,3]', `nums = ${JSON.stringify(nums)}`);

  // Client-Stream
  async function* uploadGen() { yield 10; yield 20; yield 30; }
  const u = await rpcClient.upload({ tag: 'x' }, uploadGen());
  assert(u.tag === 'x' && u.sum === 60, `upload = ${JSON.stringify(u)}`);

  // Bidi-Stream
  async function* chatGen() { yield 'hello'; yield 'bye'; }
  const replies = await rpcClient.chat({ room: 'test' }, chatGen());
  const chats: string[] = [];
  for await (const r of replies) chats.push(r);
  assert(JSON.stringify(chats) === '["[test] hello","[test] bye"]', `chat = ${JSON.stringify(chats)}`);

  // ── 5. 向前兼容：内置 impl 模式 ──────────────

  console.log('\n── 向前兼容 RpcImpl（内置 call） ──');

  const [txSrv2, txCli2] = createMemTransportPair();
  const client2 = new Client(txCli2);

  // 跟当前一样的完整定义
  const apiFull = {
    ping: RpcImpl.unary({
      input: { msg: z.string() },
      output: z.string(),
      call: async ({ input }) => `pong: ${input.msg}`,
    }),
    count: RpcImpl.serverStream({
        input: { to: z.number() },
        output: z.number(),
        call: async function* ({ input }) {
          for (let i = 1; i <= input.to; i++) {
            await new Promise(r => setImmediate(r));
            yield i;
          }
        },
      }),
  } as const;

  const rpcServer2 = new RpcServer({ router: apiFull, transport: txSrv2 });
  // 含 call, 自动注册, 无需 .on()

  const rpcClient2 = createClient(client2, apiFull);
  const r3 = await rpcClient2.ping({ msg: 'hi' });
  assert(r3 === 'pong: hi', `ping = ${r3}`);

  const h2 = await rpcClient2.count({ to: 3 });
  const countNums: number[] = [];
  for await (const v of h2) countNums.push(v);
  assert(JSON.stringify(countNums) === '[1,2,3]', `count = ${JSON.stringify(countNums)}`);

  // ── 结果 ─────────────────────────────────

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
