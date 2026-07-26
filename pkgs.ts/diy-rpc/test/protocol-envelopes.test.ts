/**
 * 协议信封层测试：验证调用 API 时实际收发的原始 Envelope 序列
 */

import type { Transport, StreamHandle } from '../src/transport/types';
import { Server, Client } from '../src/transport';
import { rpc, router, createHandler, createClient } from '../src/rpc';
import { z } from 'zod';

// ═══════════════════════════════════════════════════
//  传输层录制器
// ═══════════════════════════════════════════════════

interface EnvelopeLog {
  dir: '>' | '<';
  envelope: Record<string, unknown>;
}

function createLoggedMemTransportPair(): {
  serverTx: Transport; clientTx: Transport; logs: EnvelopeLog[];
} {
  const logs: EnvelopeLog[] = [];
  const qServer: unknown[] = [], qClient: unknown[] = [];
  const serverListeners = new Set<Function>(), clientListeners = new Set<Function>();

  function drain() {
    while (qServer.length > 0) {
      const msg = qServer.shift()!;
      logs.push({ dir: '<', envelope: deepClone(msg as Record<string, unknown>) });
      for (const h of clientListeners) h(msg);
    }
    while (qClient.length > 0) {
      const msg = qClient.shift()!;
      logs.push({ dir: '>', envelope: deepClone(msg as Record<string, unknown>) });
      for (const h of serverListeners) h(msg);
    }
    if (qServer.length > 0 || qClient.length > 0) setImmediate(drain);
  }

  return {
    serverTx: { send(p) { qServer.push(p); setImmediate(drain); }, on(h) { serverListeners.add(h); return () => serverListeners.delete(h); }, onClose() { return () => {}; } },
    clientTx: { send(p) { qClient.push(p); setImmediate(drain); }, on(h) { clientListeners.add(h); return () => clientListeners.delete(h); }, onClose() { return () => {}; } },
    logs,
  };
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// ═══════════════════════════════════════════════════
//  信封匹配器
// ═══════════════════════════════════════════════════

type LogPattern = {
  dir: '>' | '<';
  [key: string]: unknown;
}[];

function matchEnvelope(actual: Record<string, unknown>, pattern: Record<string, unknown>): boolean {
  for (const key of Object.keys(pattern)) {
    if (key === 'dir') continue;
    if (pattern[key] === 'any') continue;
    if (typeof pattern[key] === 'object' && pattern[key] !== null) {
      if (!matchEnvelope(actual[key] as any, pattern[key] as any)) return false;
    } else if (actual[key] !== pattern[key]) {
      return false;
    }
  }
  return true;
}

function assertLog(logs: EnvelopeLog[], expected: LogPattern): void {
  if (logs.length !== expected.length) {
    const e = JSON.stringify(expected.map(e => `${e.dir} ${e.type || e.kind}`));
    const a = JSON.stringify(logs.map(l => `${l.dir} ${l.envelope.type}`));
    throw new Error(`Envelope count mismatch:\n  expected ${expected.length}: ${e}\n  got ${logs.length}: ${a}`);
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const actual = logs[i];
    if (actual.dir !== exp.dir) {
      throw new Error(`Envelope #${i}: expected dir=${exp.dir} but got ${actual.dir}`);
    }
    if (!matchEnvelope(actual.envelope, exp)) {
      throw new Error(
        `Envelope #${i} mismatch:\n  expected: ${JSON.stringify(exp)}\n  actual:   ${JSON.stringify(actual.envelope)}`
      );
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

async function testUnaryEnvelopes() {
  console.log('\n── Unary 信封序列 ──');
  const { serverTx, clientTx, logs } = createLoggedMemTransportPair();
  const server = new Server(serverTx);
  const client = new Client(clientTx);

  server.onUnary('greet', (p: { name: string }) => `Hello ${p.name}!`);

  const res = await client.invoke<{ name: string }, string>('greet', { name: 'World' });
  assert(res === 'Hello World!', `result = ${res}`);

  assertLog(logs, [
    { dir: '>', type: 'call', method: 'greet' },
    { dir: '<', type: 'call', id: 'any', result: 'Hello World!' },
  ]);
}

async function testServerStreamEnvelopes() {
  console.log('\n── Server-Stream 信封序列 ──');
  const { serverTx, clientTx, logs } = createLoggedMemTransportPair();
  const server = new Server(serverTx);
  const client = new Client(clientTx);

  server.onServerStream('count', async function* (p: { to: number }) {
    for (let i = 0; i < p.to; i++) {
      await new Promise(r => setImmediate(r));
      yield { val: i };
    }
  });

  const handle = await client.serverStream<{ to: number }, { val: number }>('count', { to: 2 });
  const out: { val: number }[] = [];
  for await (const v of handle) out.push(v);
  assert(JSON.stringify(out) === '[{"val":0},{"val":1}]', `result = ${JSON.stringify(out)}`);

  assertLog(logs, [
    { dir: '>', type: 'call', method: 'count', stream: true },
    { dir: '<', type: 'call', id: 'any', stream: 'any' },
    { dir: '<', type: 'data', stream: 'any', value: { val: 0 } },
    { dir: '<', type: 'data', stream: 'any', value: { val: 1 } },
    { dir: '<', type: 'end', stream: 'any' },
  ]);
}

async function testClientStreamEnvelopes() {
  console.log('\n── Client-Stream 信封序列 ──');
  const { serverTx, clientTx, logs } = createLoggedMemTransportPair();
  const server = new Server(serverTx);
  const client = new Client(clientTx);

  server.onClientStream('upload', async (p: { tag: string }, chunks: StreamHandle<string>) => {
    const items: string[] = [];
    for await (const c of chunks) items.push(c);
    return { tag: p.tag, items };
  });

  async function* gen() { yield 'a'; yield 'b'; }

  const res = await client.clientStream<{ tag: string }, string, { tag: string; items: string[] }>(
    'upload', { tag: 'demo' }, gen(),
  );
  assert(JSON.stringify(res.items) === '["a","b"]', `result = ${JSON.stringify(res)}`);

  assertLog(logs, [
    { dir: '>', type: 'call', method: 'upload', stream: true },
    { dir: '<', type: 'call', id: 'any', stream: 'any' },
    { dir: '>', type: 'data', stream: 'any', value: 'a' },
    { dir: '>', type: 'data', stream: 'any', value: 'b' },
    { dir: '>', type: 'end', stream: 'any' },
    { dir: '<', type: 'call', id: 'any', result: { tag: 'demo', items: ['a', 'b'] } },
  ]);
}

async function testBidiStreamEnvelopes() {
  console.log('\n── Bidi-Stream 信封序列 ──');
  const { serverTx, clientTx, logs } = createLoggedMemTransportPair();
  const server = new Server(serverTx);
  const client = new Client(clientTx);

  server.onBidiStream('echo', async function* (p: { prefix: string }, incoming: StreamHandle<string>) {
    for await (const m of incoming) {
      await sleep(1);
      yield `${p.prefix}: ${m}`;
    }
  });

  async function* gen() { yield 'hello'; yield 'bye'; }

  const replies = await client.bidiStream<{ prefix: string }, string, string>('echo', { prefix: 'got' }, gen());
  const out: string[] = [];
  for await (const r of replies) out.push(r);
  assert(JSON.stringify(out) === '["got: hello","got: bye"]', `result = ${JSON.stringify(out)}`);

  assertLog(logs, [
    { dir: '>', type: 'call', method: 'echo', stream: true },
    { dir: '<', type: 'call', id: 'any', stream: 'any' },
    { dir: '>', type: 'data', stream: 'any', value: 'hello' },
    { dir: '>', type: 'data', stream: 'any', value: 'bye' },
    { dir: '>', type: 'end', stream: 'any' },
    { dir: '<', type: 'data', stream: 'any', value: 'got: hello' },
    { dir: '<', type: 'data', stream: 'any', value: 'got: bye' },
    { dir: '<', type: 'end', stream: 'any' },
  ]);
}

async function testRpcLayerEnvelopes() {
  console.log('\n── RPC 层信封序列 ──');
  const { serverTx, clientTx, logs } = createLoggedMemTransportPair();
  const server = new Server(serverTx);
  const client = new Client(clientTx);

  const app = router({
    ping: rpc.unary({
      input: { msg: z.string() },
      output: z.string(),
      call: ({ input }) => `pong: ${input.msg}`,
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

  createHandler({ router: app, transport: server, ctx: {} });
  const rpcClient = createClient<typeof app>(client, app);

  const pong = await rpcClient.ping({ msg: 'hi' });
  assert(pong === 'pong: hi', `ping = ${pong}`);

  async function* gen() { yield 10; yield 20; }
  const u = await rpcClient.upload({ tag: 'x' }, gen());
  assert(u.sum === 30, `upload sum = ${u.sum}`);

  assertLog(logs, [
    { dir: '>', type: 'call', method: 'ping', params: { input: { msg: 'hi' }, meta: {} } },
    { dir: '<', type: 'call', id: 'any', result: 'pong: hi' },
    { dir: '>', type: 'call', method: 'upload', stream: true, params: { input: { tag: 'x' }, meta: {} } },
    { dir: '<', type: 'call', id: 'any', stream: 'any' },
    { dir: '>', type: 'data', stream: 'any', value: 10 },
    { dir: '>', type: 'data', stream: 'any', value: 20 },
    { dir: '>', type: 'end', stream: 'any' },
    { dir: '<', type: 'call', id: 'any', result: { tag: 'x', sum: 30 } },
  ]);
}

async function main() {
  await testUnaryEnvelopes();
  await testServerStreamEnvelopes();
  await testClientStreamEnvelopes();
  await testBidiStreamEnvelopes();
  await testRpcLayerEnvelopes();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
