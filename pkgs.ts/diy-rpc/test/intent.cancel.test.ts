/**
 * intent.cancel.test.ts — 取消与生命周期「意图测试」（需求定义即本文件）
 *
 * 本文件面向「写 handler 的应用作者」与「发调用的应用作者」，
 * 只使用第 3 层公共 API（RpcSchema / createTypedClient / CallOptions.signal / RpcError），
 * 断言**黑盒可观测行为**（调用落定、错误码、流交付、handler 能观察到什么），
 * 不描述实现（不引用内部表、监听器计数、帧结构）。
 *
 * 需求矩阵（C = 契约，N = 已知语义边界）：
 *
 *   C1  abort 是确定终态：调用/流以 CANCELLED 失败，永不成功（四流模式）
 *   C2  取消对服务端可见：四流 handler 都能收到 signal，abort 后 signal.aborted = true
 *   C3  取消即停止交付：abort 后客户端不再收到任何数据（终态后零产出）
 *   C4  dispose 是「本地关闭」：以 DISPOSED 落定，与 CANCELLED 可区分
 *   C5  正常路径基线：无取消时四流模式的结果、顺序、终止完整无损
 *   C6  服务端错误保真：错误码/消息原样跨线传播（不被取消机制吞掉）
 *   C7  服务端 best-effort 收尾：客户端取消后，服务端 handler 的 finally 执行
 *   C8  上传迭代器 best-effort 清理：abort 与 dispose 都会给上游 iterator 发 return() 通知
 *   C9  超时是独立终态：timeout 只约束 init/ack 窗口（TIMEOUT ≠ CANCELLED）；
 *       流式调用 ack 之后没有调用级超时（慢产出必须能正常完成）
 *   C10 取消不污染后续：取消一个调用后，同一 client 的后续调用正常
 *   C11 取消幂等：重复 abort、或在调用已落定后 abort，均无副作用
 *   C12 传输一致：以上全部在 channel(in-memory) / http2 / ws 三种传输下相同
 *
 *   N1  async generator 语义边界：return 请求不打断 await（至下一个 yield 才收尾）；
 *       服务端收尾最迟发生在下一帧产出点。self-iterable 不受此限（C7/C8 场景）
 *   N2  dispose 不 abort 调用方传入的 signal——signal 生命周期归调用方所有
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RpcSchema,
  RpcError,
  createTypedClient,
  type CallOptions,
} from '../src/index';
import { channelHarness, httpHarness, wsHarness, type TransportHarness } from './harness';

// ═══════════════════════════════════════════════════
//  需求域 API（应用作者视角）
// ═══════════════════════════════════════════════════

const api = RpcSchema.router({
  echo: RpcSchema.unary({ input: { v: z.number() }, output: z.number() }),
  slowEcho: RpcSchema.unary({ input: { delay: z.number(), v: z.number() }, output: z.number() }),
  boom: RpcSchema.unary({ input: { v: z.number() }, output: z.number() }),
  tick: RpcSchema.serverStream({ input: { interval: z.number(), max: z.number() }, output: z.number() }),
  collect: RpcSchema.clientStream({
    input: { tag: z.string() },
    chunkIn: z.number(),
    output: z.object({ tag: z.string(), sum: z.number() }),
  }),
  chat: RpcSchema.bidiStream({ input: { room: z.string() }, chunkIn: z.string(), chunkOut: z.string() }),
});

const transports = [
  ['channel(in-memory)', channelHarness],
  ['http2', httpHarness],
  ['ws', wsHarness],
] as const satisfies readonly (readonly [string, TransportHarness])[];

// ═══════════════════════════════════════════════════
//  helpers
// ═══════════════════════════════════════════════════

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeout = 1000, step = 10): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}

/** 永挂的上游迭代器（模拟不可取消的第三方 next()） */
function hangingIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<T>>(() => { /* 永挂 */ }),
    }),
  };
}

/** 永挂但可观察 return() 通知的上游迭代器（模拟持有资源的第三方流） */
function hangWithReturn<T>(state: { returned: boolean }): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<T>>(() => { /* 永挂 */ }),
      return: () => {
        state.returned = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
}

// ═══════════════════════════════════════════════════
//  C1 abort 是确定终态
// ═══════════════════════════════════════════════════

describe('C1 abort 是确定终态：调用以 CANCELLED 失败，永不成功', () => {
  it.each(transports)('%s: unary——等待响应期间 abort → CANCELLED', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.slowEcho, () => new Promise<number>(() => { /* 永挂 */ }));
    try {
      const ac = new AbortController();
      const p = cli.slowEcho({ delay: 0, v: 1 }, { signal: ac.signal });
      await sleep(20);
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await dispose();
    }
  });

  it.each(transports)('%s: serverStream——消费中途 abort → 迭代以 CANCELLED 结束', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.tick, async function* ({ input }) {
      for (;;) { yield 0; await sleep(input.interval); }
    });
    try {
      const ac = new AbortController();
      const stream = await cli.tick({ interval: 10, max: 0 }, { signal: ac.signal });
      const iter = stream[Symbol.asyncIterator]();
      await iter.next(); // 先消费一帧，确保流已建立
      ac.abort();
      await expect(iter.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await dispose();
    }
  });

  it.each(transports)('%s: clientStream——上传期间 abort → CANCELLED', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.collect, () => new Promise<{ tag: string; sum: number }>(() => { /* 永挂 */ }));
    try {
      const ac = new AbortController();
      const p = cli.collect({ tag: 'x' }, hangingIterable<number>(), { signal: ac.signal });
      await sleep(20);
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await dispose();
    }
  });

  it.each(transports)('%s: bidiStream——双向进行中 abort → 输出迭代以 CANCELLED 结束', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.chat, async function* ({ stream }) {
      for await (const m of stream) yield m;
    });
    try {
      const ac = new AbortController();
      const stream = await cli.chat({ room: 'r' }, hangingIterable<string>(), { signal: ac.signal });
      const iter = stream[Symbol.asyncIterator]();
      ac.abort();
      await expect(iter.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C2 取消对服务端可见
// ═══════════════════════════════════════════════════

describe('C2 取消对服务端可见：handler 收到 signal，abort 后 signal.aborted = true', () => {
  it.each(transports)('%s: 四流 handler 均能观察取消', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    const seen: Record<string, AbortSignal> = {};
    binding.on(api.slowEcho, ({ signal }) => {
      seen.unary = signal;
      return new Promise<number>(() => { /* 永挂 */ });
    });
    binding.on(api.tick, async function* ({ input, signal }) {
      seen.serverStream = signal;
      for (;;) { yield 0; await sleep(input.interval); }
    });
    binding.on(api.collect, async ({ signal, stream }) => {
      seen.clientStream = signal;
      for await (const _ of stream) { /* 消费到取消 */ }
      return { tag: '', sum: 0 };
    });
    binding.on(api.chat, async function* ({ signal, stream }) {
      seen.bidiStream = signal;
      for await (const m of stream) yield m;
    });
    try {
      const ac = {
        unary: new AbortController(),
        serverStream: new AbortController(),
        clientStream: new AbortController(),
        bidiStream: new AbortController(),
      };
      const pu = cli.slowEcho({ delay: 0, v: 1 }, { signal: ac.unary.signal });
      const ss = await cli.tick({ interval: 10, max: 0 }, { signal: ac.serverStream.signal });
      const si = ss[Symbol.asyncIterator]();
      const pc = cli.collect({ tag: 't' }, hangingIterable<number>(), { signal: ac.clientStream.signal });
      const bs = await cli.chat({ room: 'r' }, hangingIterable<string>(), { signal: ac.bidiStream.signal });
      const bi = bs[Symbol.asyncIterator]();
      // 四个 handler 全部启动（流的首帧/挂起点已就位）
      await si.next();
      expect(await waitFor(() => Object.keys(seen).length === 4), 'handler 未全部启动').toBe(true);
      // 先 attach 四个终态断言（abort 前登记，避免 unhandledRejection）
      const settledUnary = expect(pu).rejects.toMatchObject({ code: 'CANCELLED' });
      const settledClientStream = expect(pc).rejects.toMatchObject({ code: 'CANCELLED' });
      const settledServerStream = expect(si.next()).rejects.toMatchObject({ code: 'CANCELLED' });
      const settledBidi = expect(bi.next()).rejects.toMatchObject({ code: 'CANCELLED' });
      for (const c of Object.values(ac)) c.abort();
      // 服务端观察点：abort 必须到达 handler 的 signal
      expect(await waitFor(() => Object.values(seen).every((s) => s.aborted)), 'handler 未观察到取消').toBe(true);
      // 客户端观察点：四个调用都以 CANCELLED 落定
      await Promise.all([settledUnary, settledClientStream, settledServerStream, settledBidi]);
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C3 取消即停止交付
// ═══════════════════════════════════════════════════

describe('C3 取消即停止交付：abort 后客户端不再收到数据', () => {
  it.each(transports)('%s: serverStream 在 abort 后零产出', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.tick, async function* ({ input }) {
      let i = 0;
      for (;;) { yield i++; await sleep(input.interval); }
    });
    try {
      const ac = new AbortController();
      const stream = await cli.tick({ interval: 25, max: 0 }, { signal: ac.signal });
      const iter = stream[Symbol.asyncIterator]();
      const got: number[] = [];
      got.push((await iter.next()).value as number);
      got.push((await iter.next()).value as number);
      ac.abort();
      const frozen = got.length;
      await sleep(150); // ≥ 5 个产出周期
      expect(got.length, 'abort 后仍在交付数据').toBe(frozen);
      await expect(iter.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C4 dispose 是本地关闭
// ═══════════════════════════════════════════════════

describe('C4 dispose 是「本地关闭」：以 DISPOSED 落定（与 CANCELLED 区分）', () => {
  it.each(transports)('%s: unary——挂起调用 + dispose → DISPOSED', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.slowEcho, () => new Promise<number>(() => { /* 永挂 */ }));
    try {
      const p = cli.slowEcho({ delay: 0, v: 1 });
      await sleep(20);
      client.dispose();
      await expect(p).rejects.toMatchObject({ code: 'DISPOSED' });
    } finally {
      await dispose();
    }
  });

  it.each(transports)('%s: serverStream——消费中 dispose → DISPOSED', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.tick, async function* ({ input }) {
      for (;;) { yield 0; await sleep(input.interval); }
    });
    try {
      const stream = await cli.tick({ interval: 20, max: 0 });
      const iter = stream[Symbol.asyncIterator]();
      await iter.next();
      client.dispose();
      await expect(iter.next()).rejects.toMatchObject({ code: 'DISPOSED' });
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C5 正常路径基线
// ═══════════════════════════════════════════════════

describe('C5 正常路径基线：无取消时四流模式完整正确', () => {
  it.each(transports)('%s: unary / serverStream / clientStream / bidiStream', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.echo, ({ input }) => input.v * 2);
    binding.on(api.tick, async function* ({ input }) {
      for (let i = 0; i < input.max; i++) yield i;
    });
    binding.on(api.collect, async ({ input, stream }) => {
      let sum = 0;
      for await (const v of stream) sum += v;
      return { tag: input.tag, sum };
    });
    binding.on(api.chat, async function* ({ input, stream }) {
      for await (const m of stream) yield `[${input.room}] ${m}`;
    });
    try {
      expect(await cli.echo({ v: 21 })).toBe(42);

      const nums: number[] = [];
      for await (const v of await cli.tick({ interval: 0, max: 3 })) nums.push(v);
      expect(nums).toEqual([0, 1, 2]);

      async function* chunks() { yield 1; yield 2; yield 3; }
      expect(await cli.collect({ tag: 's' }, chunks())).toEqual({ tag: 's', sum: 6 });

      async function* msgs() { yield 'a'; yield 'b'; }
      const out: string[] = [];
      for await (const v of await cli.chat({ room: 'r' }, msgs())) out.push(v);
      expect(out).toEqual(['[r] a', '[r] b']);
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C6 服务端错误保真
// ═══════════════════════════════════════════════════

describe('C6 服务端错误保真：错误码/消息原样跨线', () => {
  it.each(transports)('%s: unary handler 抛错 → 客户端收到同码同消息', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.boom, () => { throw new RpcError('BOOM', '服务端炸了'); });
    try {
      await expect(cli.boom({ v: 1 })).rejects.toMatchObject({ code: 'BOOM', message: '服务端炸了' });
    } finally {
      await dispose();
    }
  });

  it.each(transports)('%s: serverStream 中途抛错 → 迭代以同码同消息结束', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.tick, async function* () {
      yield 0;
      throw new RpcError('BOOM', '流中途炸了');
    });
    try {
      const iter = (await cli.tick({ interval: 0, max: 0 }))[Symbol.asyncIterator]();
      expect((await iter.next()).value).toBe(0);
      await expect(iter.next()).rejects.toMatchObject({ code: 'BOOM', message: '流中途炸了' });
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C7 服务端 best-effort 收尾
// ═══════════════════════════════════════════════════

describe('C7 服务端 best-effort 收尾：客户端取消后 handler 的 finally 执行', () => {
  it.each(transports)('%s: bidi handler 消费输入，取消后收尾', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    const state = { finallyRan: false };
    binding.on(api.chat, async function* ({ stream }) {
      try {
        for await (const m of stream) yield m;
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const ac = new AbortController();
      const stream = await cli.chat({ room: 'r' }, hangingIterable<string>(), { signal: ac.signal });
      const iter = stream[Symbol.asyncIterator]();
      ac.abort();
      await expect(iter.next()).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await waitFor(() => state.finallyRan), '取消后 handler 未收尾').toBe(true);
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C8 上传迭代器 best-effort 清理
// ═══════════════════════════════════════════════════

describe('C8 上传迭代器 best-effort 清理：abort/dispose 都通知上游 return()', () => {
  it.each(transports)('%s: abort 与 dispose 均触发上游 return() 通知', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.collect, () => new Promise<{ tag: string; sum: number }>(() => { /* 永挂 */ }));
    try {
      // 段 1：abort
      const s1 = { returned: false };
      const ac = new AbortController();
      const p1 = cli.collect({ tag: 'a' }, hangWithReturn<number>(s1), { signal: ac.signal });
      await sleep(20);
      ac.abort();
      await expect(p1).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await waitFor(() => s1.returned), 'abort 后未通知上游 iterator').toBe(true);

      // 段 2：dispose
      const s2 = { returned: false };
      const p2 = cli.collect({ tag: 'b' }, hangWithReturn<number>(s2));
      await sleep(20);
      client.dispose();
      await expect(p2).rejects.toMatchObject({ code: 'DISPOSED' });
      expect(await waitFor(() => s2.returned), 'dispose 后未通知上游 iterator').toBe(true);
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C9 超时是独立终态
// ═══════════════════════════════════════════════════

describe('C9 超时语义：timeout 只约束 init/ack 窗口，是独立的 TIMEOUT 终态', () => {
  it.each(transports)('%s: unary 等待超时 → TIMEOUT', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.slowEcho, async ({ input }) => { await sleep(input.delay); return input.v; });
    try {
      await expect(cli.slowEcho({ delay: 200, v: 1 }, { timeout: 40 }))
        .rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally {
      await dispose();
    }
  });

  it.each(transports)('%s: serverStream——ack 后无调用级超时（慢产出正常完成）', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.tick, async function* ({ input }) {
      for (let i = 0; i < input.max; i++) { yield i; await sleep(input.interval); }
    });
    try {
      const opts: CallOptions = { timeout: 40 };
      const nums: number[] = [];
      // 总历时 ~180ms 远超 timeout=40，但 timeout 只约束 ack（已立即到达）→ 不超时
      for await (const v of await cli.tick({ interval: 60, max: 3 }, opts)) nums.push(v);
      expect(nums).toEqual([0, 1, 2]);
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  C10 / C11 取消的局部性
// ═══════════════════════════════════════════════════

describe('C10 取消不污染后续：同一 client 继续正常', () => {
  it.each(transports)('%s: 取消一个调用后，下一个调用正常返回', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.slowEcho, async ({ input }) => { await sleep(input.delay); return input.v; });
    try {
      const ac = new AbortController();
      const p = cli.slowEcho({ delay: 300, v: 9 }, { signal: ac.signal });
      await sleep(20);
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await cli.slowEcho({ delay: 0, v: 7 })).toBe(7);
    } finally {
      await dispose();
    }
  });
});

describe('C11 取消幂等：重复 abort / 落定后 abort 均无副作用', () => {
  it.each(transports)('%s: 同一 signal 多次 abort 不抛、不改变已落定结果', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.slowEcho, async ({ input }) => { await sleep(input.delay); return input.v; });
    try {
      const ac = new AbortController();
      const p = cli.slowEcho({ delay: 100, v: 1 }, { signal: ac.signal });
      ac.abort();
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(() => { ac.abort(); }).not.toThrow(); // 已落定后再次 abort
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  N1 / N2 已知语义边界（接受的设计约束）
// ═══════════════════════════════════════════════════

describe('N1 async generator 语义边界：return 请求不打断 await（至下一个 yield 才收尾）', () => {
  it.each(transports)('%s: 事件序列固定为 [enter, await1, await2, finally]', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    const events: string[] = [];
    binding.on(api.chat, async function* () {
      try {
        events.push('enter');
        await sleep(40);
        events.push('after-await-1');
        await sleep(40);
        events.push('after-await-2');
        yield 'x';
      } finally {
        events.push('finally');
      }
    });
    try {
      const ac = new AbortController();
      const stream = await cli.chat({ room: 'r' }, hangingIterable<string>(), { signal: ac.signal });
      expect(await waitFor(() => events.includes('enter')), 'handler 未启动').toBe(true);
      ac.abort();
      const iter = stream[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toMatchObject({ code: 'CANCELLED' });
      await sleep(200); // 等所有 await 结束
      // 若 return 能打断 await，序列会是 [enter, await1, finally]；实际受 JS 语义约束
      expect(events).toEqual(['enter', 'after-await-1', 'after-await-2', 'finally']);
    } finally {
      await dispose();
    }
  });
});

describe('N2 dispose 不 abort 调用方的 signal', () => {
  it.each(transports)('%s: dispose 完成后 signal.aborted 仍为 false', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const cli = createTypedClient(client, api);
    binding.on(api.slowEcho, () => new Promise<number>(() => { /* 永挂 */ }));
    try {
      const ac = new AbortController();
      const p = cli.slowEcho({ delay: 0, v: 1 }, { signal: ac.signal });
      await sleep(20);
      client.dispose();
      await expect(p).rejects.toMatchObject({ code: 'DISPOSED' });
      expect(ac.signal.aborted, 'dispose 不应动调用方 signal').toBe(false);
    } finally {
      await dispose();
    }
  });
});
