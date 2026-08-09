/**
 * 传输层 ServerBinding/ClientBinding 独立测试（四种流模式 + 取消）
 *
 * 用 in-memory EnvelopeTransport 替代 Electron IPC，
 * 直接验证 ServerBinding/ClientBinding 的信封协议和流处理逻辑。
 * 注册以 meta 为键（onUnary(meta, handler)），client 调用带 { input, meta } 包装。
 */

import { it } from 'vitest';
import { z } from 'zod';
import type { EnvelopeTransport } from '../src/core/types';
import { ChannelServerBinding, ChannelClientBinding } from '../src/core';
import { router, RpcSchema } from '../src/index';

const api = router({
  greet: RpcSchema.unary({ input: { name: z.string() }, output: z.string() }),
  fail: RpcSchema.unary({ input: {}, output: z.unknown() }),
  count: RpcSchema.serverStream({ input: { to: z.number() }, output: z.number() }),
  upload: RpcSchema.clientStream({
    input: { tag: z.string() }, chunkIn: z.string(),
    output: z.object({ tag: z.string(), received: z.array(z.string()) }),
  }),
  limited: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.object({ count: z.number() }) }),
  echo: RpcSchema.bidiStream({ input: {}, chunkIn: z.string(), chunkOut: z.string() }),
  slow: RpcSchema.unary({ input: {}, output: z.string() }),
} as const);

// ═══════════════════════════════════════════════════
//  in-memory EnvelopeTransport
// ═══════════════════════════════════════════════════

function createMemTransportPair(): [EnvelopeTransport, EnvelopeTransport] {
  const qServer: unknown[] = [];    // server → client messages
  const qClient: unknown[] = [];    // client → server messages
  const serverListeners = new Set<Function>();
  const clientListeners = new Set<Function>();

  function drain() {
    // server 发出的消息 → 交给 client 的监听器
    while (qServer.length > 0) { const m = qServer.shift()!; for (const h of clientListeners) h(m); }
    // client 发出的消息 → 交给 server 的监听器
    while (qClient.length > 0) { const m = qClient.shift()!; for (const h of serverListeners) h(m); }
    if (qServer.length > 0 || qClient.length > 0) setImmediate(drain);
  }

  return [
    { send(p) { qServer.push(p); setImmediate(drain); }, on(h) { serverListeners.add(h); return () => serverListeners.delete(h); }, onClose() { return () => {}; } },
    { send(p) { qClient.push(p); setImmediate(drain); }, on(h) { clientListeners.add(h); return () => clientListeners.delete(h); }, onClose() { return () => {}; } },
  ];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, msg: string) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; throw new Error(msg); }
  }

  // ── 1. Unary ──────────────────────────────────

  console.log('\n── Unary ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelServerBinding(txA);
    const client = new ChannelClientBinding(txB);

    server.onUnary(api.greet, ({ input }) => `Hello, ${input.name}!`);
    server.onUnary(api.fail, () => { throw new Error('boom'); });

    const r1 = await client.invoke<{ input: { name: string }; meta: unknown }, string>('greet', { input: { name: 'World' }, meta: {} });
    assert(r1 === 'Hello, World!', `greet = ${JSON.stringify(r1)}`);

    try {
      await client.invoke('fail', { input: {}, meta: {} });
      assert(false, 'should have thrown');
    } catch (e: any) {
      assert(e.message === 'boom', `fail error = ${e.message}`);
    }
  }

  // ── 2. Server-Stream ──────────────────────────

  console.log('\n── Server-Stream ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelServerBinding(txA);
    const client = new ChannelClientBinding(txB);

    server.onServerStream(api.count, async function* ({ input }) {
      for (let i = 1; i <= input.to; i++) {
        await new Promise(r => setImmediate(r));
        yield i;
      }
    });

    const handle = await client.serverStream<{ input: { to: number }; meta: unknown }, number>('count', { input: { to: 3 }, meta: {} });
    const results: number[] = [];
    for await (const v of handle) results.push(v);
    assert(JSON.stringify(results) === '[1,2,3]', `count = ${JSON.stringify(results)}`);
  }

  // ── 3. Client-Stream ──────────────────────────

  console.log('\n── Client-Stream ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelServerBinding(txA);
    const client = new ChannelClientBinding(txB);

    server.onClientStream(api.upload, async ({ input, stream }) => {
      let received: string[] = [];
      for await (const c of stream) received.push(c);
      return { tag: input.tag, received };
    });

    async function* gen() { yield 'a'; yield 'b'; yield 'c'; }

    const result = await client.clientStream<{ input: { tag: string }; meta: unknown }, string, { tag: string; received: string[] }>(
      'upload', { input: { tag: 'demo' }, meta: {} }, gen(),
    );
    assert(result.tag === 'demo', `result.tag = ${result.tag}`);
    assert(JSON.stringify(result.received) === '["a","b","c"]', `result.received = ${JSON.stringify(result.received)}`);
  }

  // ── 3b. Client-Stream: cancel via AbortController ──

  console.log('\n── Client-Stream (abort) ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelServerBinding(txA);
    const client = new ChannelClientBinding(txB);

    server.onClientStream(api.limited, async ({ stream }) => {
      let count = 0;
      for await (const _ of stream) {
        count++;
      }
      return { count };
    });

    const ac = new AbortController();
    async function* many() { for (let i = 0; i < 100; i++) { await sleep(1); yield i; } }

    // Abort after a short delay
    setTimeout(() => ac.abort(), 30);

    const result = await client.clientStream<{ input: Record<string, never>; meta: unknown }, number, { count: number }>('limited', { input: {}, meta: {} }, many(), { signal: ac.signal });
    assert(result.count >= 1, `got ${result.count} items before abort`);
  }

  // ── 4. Bidi-Stream ────────────────────────────

  console.log('\n── Bidi-Stream ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelServerBinding(txA);
    const client = new ChannelClientBinding(txB);

    server.onBidiStream(api.echo, async function* ({ stream }) {
      for await (const msg of stream) {
        await sleep(1);
        yield `echo: ${msg}`;
      }
    });

    async function* msgs() { yield 'hello'; yield 'world'; }

    const replies = await client.bidiStream<{ input: Record<string, never>; meta: unknown }, string, string>('echo', { input: {}, meta: {} }, msgs());
    const out: string[] = [];
    for await (const r of replies) out.push(r);
    assert(JSON.stringify(out) === '["echo: hello","echo: world"]', `replies = ${JSON.stringify(out)}`);
  }

  // ── 5. AbortController on unary ───────────────

  console.log('\n── AbortController (unary) ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelServerBinding(txA);
    const client = new ChannelClientBinding(txB);

    server.onUnary(api.slow, async () => {
      await sleep(1000);
      return 'done';
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);

    try {
      await client.invoke('slow', { input: {}, meta: {} }, { signal: ac.signal });
      assert(false, 'should have aborted');
    } catch (e: any) {
      assert(e.code === 'ABORTED', `code = ${e.code}`);
    }
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);

}

it('transport-binding: ChannelServerBinding/ChannelClientBinding 端口', async () => { await main(); });
