/**
 * rpc-core.test.ts — RPC 层逻辑统一测试（合并自 rpc-layer / rpc-v2 / rpc-typed-client）
 *
 * 覆盖 RPC 装配 API 与 createTypedClient 独有特性，跑在 in-memory channel 上
 * （transport 差异已在 binding.test.ts 参数化覆盖，这里不重复各传输）。
 *   - RpcImpl 内联装配（router 带 call）：四流模式
 *   - meta/handle 分离（RpcSchema 纯定义 + binding.onXxx）：onXxx 挂载 + runtime zod 校验
 *   - createTypedClient 场景：嵌套 router、并发、client-stream 函数形式、CallOptions
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  RpcImpl, RpcSchema, createTypedClient,
  ChannelClientBinding, ChannelServerBinding, router,
} from '../src/index';
import type { EnvelopeTransport } from '../src/core/types';
import type { ServerBinding } from '../src/core/server-binding';
import { createMemTransportPair } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════
//  RpcImpl 内联装配（router 带 call）——来自 rpc-layer
// ═══════════════════════════════════════════════════

describe('RpcImpl 内联装配（router 带 call）', () => {
  it('四流模式往返', async () => {
    const [txSrv, txCli] = createMemTransportPair();

    const app = router({
      ping: RpcImpl.unary({
        input: { msg: z.string() }, output: z.string(),
        call: ({ input }) => `pong: ${input.msg}`,
      }),
      nums: RpcImpl.serverStream({
        input: { n: z.number() }, output: z.number(),
        call: async function* ({ input }) {
          for (let i = 0; i < input.n; i++) { await sleep(1); yield i; }
        },
      }),
      upload: RpcImpl.clientStream({
        input: { tag: z.string() }, chunkIn: z.number(), output: z.object({ tag: z.string(), sum: z.number() }),
        call: async ({ input, stream }) => {
          let sum = 0;
          for await (const v of stream) sum += v;
          return { tag: input.tag, sum };
        },
      }),
      chat: RpcImpl.bidiStream({
        input: { room: z.string() }, chunkIn: z.string(), chunkOut: z.string(),
        call: async function* ({ input, stream }) {
          for await (const msg of stream) yield `[${input.room}] ${msg}`;
        },
      }),
    });

    const binding = new ChannelServerBinding(txSrv);
    binding.registerRouter(app); // RpcImpl 含 call，自动注册
    const cli = createTypedClient(new ChannelClientBinding(txCli), app);

    expect(await cli.ping({ msg: 'hi' })).toBe('pong: hi');

    const h = await cli.nums({ n: 3 });
    const nums: number[] = [];
    for await (const v of h) nums.push(v);
    expect(nums).toEqual([0, 1, 2]);

    async function* uploadGen() { yield 10; yield 20; yield 30; }
    expect(await cli.upload({ tag: 'x' }, uploadGen())).toEqual({ tag: 'x', sum: 60 });

    async function* chatGen() { yield 'hello'; yield 'bye'; }
    const replies = await cli.chat({ room: 'test' }, chatGen());
    const chats: string[] = [];
    for await (const r of replies) chats.push(r);
    expect(chats).toEqual(['[test] hello', '[test] bye']);

    binding.destroy();
  });
});

// ═══════════════════════════════════════════════════
//  meta/handle 分离 + createTypedClient（来自 rpc-v2 / rpc-typed-client）
// ═══════════════════════════════════════════════════

const apiDef = router({
  math: { add: RpcSchema.unary({ input: { a: z.number(), b: z.number() }, output: z.number() }) },
  greet: RpcSchema.unary({ input: { name: z.string() }, output: z.string() }),
  slow: RpcSchema.unary({ input: { delay: z.number(), id: z.number() }, output: z.object({ id: z.number() }) }),
  count: RpcSchema.serverStream({ input: { n: z.number() }, output: z.number() }),
  upload: RpcSchema.clientStream({
    input: { tag: z.string() }, chunkIn: z.number(), output: z.object({ tag: z.string(), sum: z.number() }),
  }),
  chat: RpcSchema.bidiStream({ input: { room: z.string() }, chunkIn: z.string(), chunkOut: z.string() }),
});

function startBinding(txSrv: EnvelopeTransport): ServerBinding {
  const binding = new ChannelServerBinding(txSrv);
  // meta/handle 分离：RpcSchema 纯定义，handler 逐个 onXxx 挂载
  binding.onUnary(apiDef.math.add, async ({ input }) => input.a + input.b);
  binding.onUnary(apiDef.greet, async ({ input }) => `Hello, ${input.name}!`);
  binding.onUnary(apiDef.slow, async ({ input }) => {
    await sleep(input.delay);
    return { id: input.id };
  });
  binding.onServerStream(apiDef.count, async function* ({ input }) {
    for (let i = 0; i < input.n; i++) { await sleep(1); yield i; }
  });
  binding.onClientStream(apiDef.upload, async ({ input, stream }) => {
    let sum = 0;
    for await (const v of stream) sum += v;
    return { tag: input.tag, sum };
  });
  binding.onBidiStream(apiDef.chat, async function* ({ input, stream }) {
    for await (const msg of stream) yield `[${input.room}] ${msg}`;
  });
  return binding;
}

describe('meta/handle 分离 + createTypedClient', () => {
  it('runtime zod 输入校验：拒绝非法输入', async () => {
    const [txSrv, txCli] = createMemTransportPair();
    const binding = startBinding(txSrv);
    const cli = createTypedClient(new ChannelClientBinding(txCli), apiDef);
    // zod 校验在调用时同步 throw（validate 在参数求值阶段执行）
    expect(() => cli.math.add({ a: 'bad' as any, b: 1 })).toThrow();
    binding.destroy();
  });

  it('嵌套 router + server-stream + bidi', async () => {
    const [txSrv, txCli] = createMemTransportPair();
    const binding = startBinding(txSrv);
    const cli = createTypedClient(new ChannelClientBinding(txCli), apiDef);

    expect(await cli.math.add({ a: 3, b: 4 })).toBe(7);
    expect(await cli.greet({ name: 'World' })).toBe('Hello, World!');

    const h = await cli.count({ n: 3 });
    const nums: number[] = [];
    for await (const v of h) nums.push(v);
    expect(nums).toEqual([0, 1, 2]);

    async function* chatGen() { yield 'a'; yield 'b'; }
    const replies = await cli.chat({ room: 'r' }, chatGen());
    const chats: string[] = [];
    for await (const c of replies) chats.push(c);
    expect(chats).toEqual(['[r] a', '[r] b']);

    binding.destroy();
  });

  it('client-stream：AsyncIterable 与函数两种形式', async () => {
    const [txSrv, txCli] = createMemTransportPair();
    const binding = startBinding(txSrv);
    const cli = createTypedClient(new ChannelClientBinding(txCli), apiDef);

    async function* gen() { yield 10; yield 20; yield 30; }
    expect(await cli.upload({ tag: 'x' }, gen())).toEqual({ tag: 'x', sum: 60 });

    async function* genFn() { yield 1; yield 2; }
    expect(await cli.upload({ tag: 'fn' }, () => genFn())).toEqual({ tag: 'fn', sum: 3 });

    binding.destroy();
  });

  it('并发 unary 顺序正确', async () => {
    const [txSrv, txCli] = createMemTransportPair();
    const binding = startBinding(txSrv);
    const cli = createTypedClient(new ChannelClientBinding(txCli), apiDef);

    const results = await Promise.all([
      cli.slow({ delay: 20, id: 1 }),
      cli.slow({ delay: 5, id: 2 }),
    ]);
    expect(results.map((r) => r.id)).toEqual([1, 2]);

    binding.destroy();
  });

  it('CallOptions：signal abort', async () => {
    const [txSrv, txCli] = createMemTransportPair();
    const binding = startBinding(txSrv);
    const cli = createTypedClient(new ChannelClientBinding(txCli), apiDef);

    const ac = new AbortController();
    ac.abort();
    await expect(cli.slow({ delay: 1000, id: 1 }, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });

    binding.destroy();
  });

  it('CallOptions：timeout', async () => {
    const [txSrv, txCli] = createMemTransportPair();
    const binding = startBinding(txSrv);
    const cli = createTypedClient(new ChannelClientBinding(txCli), apiDef);

    await expect(cli.slow({ delay: 1000, id: 1 }, { timeout: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });

    binding.destroy();
  });
});
