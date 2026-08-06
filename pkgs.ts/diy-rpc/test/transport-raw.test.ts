/**
 * 传输层 RawServer/RawClient 独立测试（四种流模式 + 取消）
 *
 * 用 in-memory Transport 替代 Electron IPC，
 * 直接验证 RawServer/RawClient 的信封协议和流处理逻辑。
 */

import type { Transport } from '../src/transport/types';
import { ChannelRawServer, ChannelRawClient } from '../src/transport';

// ═══════════════════════════════════════════════════
//  in-memory Transport
// ═══════════════════════════════════════════════════

function createMemTransportPair(): [Transport, Transport] {
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
    else { failed++; console.error(`  ❌ ${msg}`); process.exit(1); }
  }

  // ── 1. Unary ──────────────────────────────────

  console.log('\n── Unary ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelRawServer(txA);
    const client = new ChannelRawClient(txB);

    server.onUnary('greet', (params: { name: string }) => `Hello, ${params.name}!`);
    server.onUnary('fail', () => { throw new Error('boom'); });

    const r1 = await client.invoke<{ name: string }, string>('greet', { name: 'World' });
    assert(r1 === 'Hello, World!', `greet = ${JSON.stringify(r1)}`);

    try {
      await client.invoke('fail', {});
      assert(false, 'should have thrown');
    } catch (e: any) {
      assert(e.message === 'boom', `fail error = ${e.message}`);
    }
  }

  // ── 2. Server-Stream ──────────────────────────

  console.log('\n── Server-Stream ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelRawServer(txA);
    const client = new ChannelRawClient(txB);

    server.onServerStream('count', async function* (p: { to: number }) {
      for (let i = 1; i <= p.to; i++) {
        await new Promise(r => setImmediate(r));
        yield i;
      }
    });

    const handle = await client.serverStream<{ to: number }, number>('count', { to: 3 });
    const results: number[] = [];
    for await (const v of handle) results.push(v);
    assert(JSON.stringify(results) === '[1,2,3]', `count = ${JSON.stringify(results)}`);
  }

  // ── 3. Client-Stream ──────────────────────────

  console.log('\n── Client-Stream ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelRawServer(txA);
    const client = new ChannelRawClient(txB);

    server.onClientStream('upload', async (params: { tag: string }, chunks: AsyncIterable<string>) => {
      let received: string[] = [];
      for await (const c of chunks) received.push(c);
      return { tag: params.tag, received };
    });

    async function* gen() { yield 'a'; yield 'b'; yield 'c'; }

    const result = await client.clientStream<{ tag: string }, string, { tag: string; received: string[] }>(
      'upload', { tag: 'demo' }, gen(),
    );
    assert(result.tag === 'demo', `result.tag = ${result.tag}`);
    assert(JSON.stringify(result.received) === '["a","b","c"]', `result.received = ${JSON.stringify(result.received)}`);
  }

  // ── 3b. Client-Stream: cancel via AbortController ──

  console.log('\n── Client-Stream (abort) ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelRawServer(txA);
    const client = new ChannelRawClient(txB);

    server.onClientStream('limited', async (_params: {}, chunks: AsyncIterable<number>) => {
      let count = 0;
      for await (const _ of chunks) {
        count++;
      }
      return { count };
    });

    const ac = new AbortController();
    async function* many() { for (let i = 0; i < 100; i++) { await sleep(1); yield i; } }

    // Abort after a short delay
    setTimeout(() => ac.abort(), 30);

    const result = await client.clientStream<{}, number, { count: number }>('limited', {}, many(), { signal: ac.signal });
    assert(result.count >= 1, `got ${result.count} items before abort`);
  }

  // ── 4. Bidi-Stream ────────────────────────────

  console.log('\n── Bidi-Stream ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelRawServer(txA);
    const client = new ChannelRawClient(txB);

    server.onBidiStream('echo', async function* (_params: {}, incoming: any) {
      for await (const msg of incoming) {
        await sleep(1);
        yield `echo: ${msg}`;
      }
    });

    async function* msgs() { yield 'hello'; yield 'world'; }

    // Use transport-level bidiStream directly (not rpc layer)
    const replies = await client.bidiStream<unknown, string, string>('echo', { input: {}, meta: {} }, msgs());
    const out: string[] = [];
    for await (const r of replies) out.push(r);
    assert(JSON.stringify(out) === '["echo: hello","echo: world"]', `replies = ${JSON.stringify(out)}`);
  }

  // ── 5. AbortController on unary ───────────────

  console.log('\n── AbortController (unary) ──');
  {
    const [txA, txB] = createMemTransportPair();
    const server = new ChannelRawServer(txA);
    const client = new ChannelRawClient(txB);

    server.onUnary('slow', async (_: any) => {
      await sleep(1000);
      return 'done';
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);

    try {
      await client.invoke('slow', {}, { signal: ac.signal });
      assert(false, 'should have aborted');
    } catch (e: any) {
      assert(e.code === 'ABORTED', `code = ${e.code}`);
    }
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
