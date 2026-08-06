/**
 * RPC 层集成测试（RpcImpl + RpcServer + createClient，四种流模式）
 *
 * 在传输层之上验证 RPC builder 的逻辑正确性。
 */

import type { Transport } from '../src/transport/types';
import { ChannelRawClient, ChannelRawServer } from '../src/transport';
import { RpcImpl, RpcServer, router, createClient } from '../src/rpc';
import { z } from 'zod';

// ═══════════════════════════════════════════════════
//  in-memory Transport
// ═══════════════════════════════════════════════════

function createMemTransportPair(): [Transport, Transport] {
  const qServer: unknown[] = [];    // server → client messages
  const qClient: unknown[] = [];    // client → server messages
  const serverListeners = new Set<Function>();
  const clientListeners = new Set<Function>();

  function drain() {
    while (qServer.length > 0) { const m = qServer.shift()!; for (const h of clientListeners) h(m); }
    while (qClient.length > 0) { const m = qClient.shift()!; for (const h of serverListeners) h(m); }
    if (qServer.length > 0 || qClient.length > 0) setImmediate(drain);
  }

  return [
    { send(p) { qServer.push(p); setImmediate(drain); }, on(h) { serverListeners.add(h); return () => serverListeners.delete(h); }, onClose() { return () => {}; } },
    { send(p) { qClient.push(p); setImmediate(drain); }, on(h) { clientListeners.add(h); return () => clientListeners.delete(h); }, onClose() { return () => {}; } },
  ];
}

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, msg: string) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.error(`  ❌ ${msg}`); process.exit(1); }
  }

  // ── RPC 层四种流模式 ─────────────────────────

  console.log('\n── RPC 层（unary / server-stream / client-stream / bidi-stream）──');
  {
    const [txA, txB] = createMemTransportPair();
    const client = new ChannelRawClient(txB);

    const app = router({
      ping: RpcImpl.unary({
        input: { msg: z.string() },
        output: z.string(),
        call: ({ input }) => `pong: ${input.msg}`,
      }),

      nums: RpcImpl.serverStream({
        input: { n: z.number() },
        output: z.number(),
        call: async function* ({ input }) {
          for (let i = 0; i < input.n; i++) {
            await new Promise(r => setImmediate(r));
            yield i;
          }
        },
      }),

      upload: RpcImpl.clientStream({
        input: { tag: z.string() },
        chunkIn: z.number(),
        output: z.object({ tag: z.string(), sum: z.number() }),
        call: async ({ input, stream }) => {
          let sum = 0;
          for await (const v of stream) sum += v;
          return { tag: input.tag, sum };
        },
      }),

      chat: RpcImpl.bidiStream({
        input: { room: z.string() },
        chunkIn: z.string(),
        chunkOut: z.string(),
        call: async function* ({ input, stream }) {
          for await (const msg of stream) yield `[${input.room}] ${msg}`;
        },
      }),
    });

    const rpcServer = new RpcServer({ router: app });
    rpcServer.registerInto(new ChannelRawServer(txA));
    const rpcClient = createClient(new ChannelRawClient(txB), app);

    const p1 = await rpcClient.ping({ msg: 'hi' });
    assert(p1 === 'pong: hi', `ping = ${p1}`);

    const h = await rpcClient.nums({ n: 3 });
    const nums: number[] = [];
    for await (const v of h) nums.push(v);
    assert(JSON.stringify(nums) === '[0,1,2]', `nums = ${JSON.stringify(nums)}`);

    async function* uploadGen() { yield 10; yield 20; yield 30; }
    const u = await rpcClient.upload({ tag: 'x' }, uploadGen());
    assert(u.tag === 'x' && u.sum === 60, `upload = ${JSON.stringify(u)}`);

    async function* chatGen() { yield 'hello'; yield 'bye'; }
    const replies = await rpcClient.chat({ room: 'test' }, chatGen());
    const chats: string[] = [];
    for await (const r of replies) chats.push(r);
    assert(JSON.stringify(chats) === '["[test] hello","[test] bye"]', `chat = ${JSON.stringify(chats)}`);
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
