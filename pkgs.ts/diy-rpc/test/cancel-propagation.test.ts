/**
 * cancel-propagation.test.ts — 「消费端离开」必须让上游收尾（跨传输）
 *
 * 契约：消费端以**任何**方式终止消费，服务端生成器都必须收尾（finally 必跑、产出停止）。
 *
 * 三条通路（缺一不可，都由「消费端已经离开」这个事实锚定）：
 *   1. break / 外层 return —— for-await 的规范清理路径：调用并 await 迭代器的 return()
 *   2. dispose()           —— 消费端进程/页面消亡
 *   3. AbortSignal         —— 调用方显式取消（对照组：实现早已支持，防回归）
 *
 * 为什么单立一份：既有 http-specific.test.ts 只覆盖第 3 条，而前两条此前**零信号**。
 * 实测后果（任务 149 现场）：renderer 被 playwright reload 销毁后，main 侧 agent
 * 在无人消费的情况下继续跑了 1 分 45 秒（多跑 16 步工具调用）；更严重的是本地会话
 * 互斥锁 `sess.running` 直到那轮自然结束才释放 —— 期间用户发任何消息都被拒
 * （「本地会话还在生成中」），表现为「中断后再也无法恢复使用」。
 *
 * 断言刻意同时检查「finally 跑了」与「产出冻结」：用户可见症状是上游继续烧 token、
 * 锁不释放，那正是产出没停的直接投影；只断言 finally 会漏掉「收尾了但还在 yield」。
 *
 * 参数化到 channel 与 http 两条真实链路，后补 ws（ws 与 channel 共用 ChannelXxxBinding）。
 * 事实边界：channelHarness 是内存 EnvelopeTransport 对（信封语义参照），并非真实
 * Electron IPC 连接；`client.dispose()` 是显式关闭，不等同 renderer 崩溃时的
 * transport onClose —— 生产中 renderer↔main 走 channel（Electron IPC）、CLI↔app
 * 走 http2，149 的故障发生在 channel 侧。
 */
import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { z } from 'zod';
import { RpcSchema, RpcError } from '../src/index';
import { channelHarness, httpHarness, wsHarness, type TransportHarness } from './harness';
import { createMemTransportPair } from './helpers';
import { ChannelServerBinding } from '../src/core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = RpcSchema.router({
  tick: RpcSchema.serverStream({ input: {}, output: z.number() }),
  /** 产出一次后挂在长 await：用于区分「只设取消标志」与「真正终结生成器」 */
  slow: RpcSchema.serverStream({ input: {}, output: z.number() }),
  // ── 取消终态矩阵（任务 185） ──
  /** unary：挂起至 signal abort，观测 signal 是否可达 handler */
  wait: RpcSchema.unary({ input: {}, output: z.boolean() }),
  /** unary：短时慢响应（dispose-before-ack / reason 映射用） */
  slowOne: RpcSchema.unary({ input: {}, output: z.boolean() }),
  /** unary：立即成功（listener 清理基线） */
  ok: RpcSchema.unary({ input: {}, output: z.boolean() }),
  /** server：有限产出（自然消费完 → listener 清理） */
  finite: RpcSchema.serverStream({ input: { n: z.number() }, output: z.number() }),
  /** client：吞入输入直至取消（观测服务端收尾） */
  drain: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.number() }),
  /** bidi：回显输入，输入结束后继续产出（半关 ≠ 取消） */
  echo: RpcSchema.bidiStream({ input: {}, chunkIn: z.number(), chunkOut: z.number() }),
});

interface TickState {
  finallyRan: boolean;
  yields: number;
}

/** 等条件成立（最多 timeout），返回最终是否成立 */
async function waitFor(pred: () => boolean, timeout = 500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

/** 收尾断言：finally 必跑，且此后产出必须冻结 */
async function expectSettled(state: TickState, what: string) {
  const settled = await waitFor(() => state.finallyRan);
  const frozen = state.yields;
  await sleep(120); // 若取消已传播，这期间产出必须冻结
  expect(settled, `${what}：服务端生成器未收尾（上游仍在白跑）`).toBe(true);
  expect(state.yields, `${what}：取消后服务端仍在产出`).toBe(frozen);
}

// ws 也纳入：renderer↔main 走 channel、CLI↔app 走 http、ws 是第三条真实链路，
// 取消语义必须三传输一致（任务 185 验收：cancel 用例覆盖 ws）。
const harnesses: TransportHarness[] = [channelHarness, httpHarness, wsHarness];

describe.each(harnesses.map((h) => [h.name, h] as const))('取消传播: %s', (_name, h) => {
  /** 起 harness + 注册 tick，返回观测状态 */
  async function setup() {
    const { binding, client, dispose } = await h.start();
    const state: TickState = { finallyRan: false, yields: 0 };
    binding.on(api.tick, async function* () {
      try {
        for (let i = 0; ; i++) {
          state.yields++;
          yield i;
          await sleep(5);
        }
      } finally {
        state.finallyRan = true;
      }
    });
    return { binding, client, dispose, state };
  }

  it('消费端 break → 服务端生成器收尾', async () => {
    const { client, dispose, state } = await setup();
    try {
      const sh = await client.serverStream('tick', { input: {}, meta: {} });
      let n = 0;
      for await (const _ of sh) {
        if (++n >= 3) break; // 消费端提前退出（最常见的「悄悄白跑」来源）
      }
      await expectSettled(state, 'break');
    } finally {
      await dispose();
    }
  });

  it('消费端 dispose → 服务端生成器收尾', async () => {
    const { client, dispose, state } = await setup();
    try {
      const sh = await client.serverStream('tick', { input: {}, meta: {} });
      const it = sh[Symbol.asyncIterator]();
      await it.next();
      await it.next();
      client.dispose(); // 消费端消亡（149 现场：renderer 被 reload 销毁）
      await expectSettled(state, 'dispose');
    } finally {
      await dispose();
    }
  });

  it('迭代器 return() → 服务端生成器收尾（for-await 的规范清理路径）', async () => {
    const { client, dispose, state } = await setup();
    try {
      const sh = await client.serverStream('tick', { input: {}, meta: {} });
      const it = sh[Symbol.asyncIterator]() as AsyncIterator<unknown> & {
        return?: () => Promise<IteratorResult<unknown>>;
      };
      await it.next();
      expect(typeof it.return, 'StreamHandle 迭代器未实现 return()，break 将无信号').toBe('function');
      await it.return?.();
      await expectSettled(state, 'return()');
    } finally {
      await dispose();
    }
  });

  it('取消时生成器正挂在长 await 中 → 取消不因 await 而丢失', async () => {
    const { binding, client, dispose } = await h.start();
    const state: TickState = { finallyRan: false, yields: 0 };
    // 首产一次后进入 400ms 等待 —— 取消就发生在这段等待里。
    // 第二个 yields++ 是「生成器是否被放行继续跑」的探针。
    binding.on(api.slow, async function* () {
      try {
        state.yields++;
        yield 0;
        await sleep(400);
        state.yields++;
        yield 1;
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const sh = await client.serverStream('slow', { input: {}, meta: {} });
      const it = sh[Symbol.asyncIterator]();
      await it.next(); // 拿到首个值，生产端已 eager 拉到下一个值 → 生成器进入 sleep(400)
      client.dispose();

      // 规范限制（实测确认）：`async generator.return()` **无法打断正在进行的 await**
      // —— 挂在 sleep 中调 return() 会一直阻塞到 sleep 结束，且 await 之后的同步语句
      // 仍会执行，completion 只在下一个 yield 点被处理。因此这里**不能**断言「立即收尾」
      // 或「不再执行后续语句」，那两种期望在 JS 里都不可能成立。
      //
      // 本用例守的是另一条更容易被破坏的契约：取消信号不能因为生成器正挂在 await 中
      // 而**丢失** —— await 结束后必须收尾，而不是被无声吞掉继续跑。
      const settled = await waitFor(() => state.finallyRan, 900);
      expect(settled, '生成器挂在 await 中时取消丢失（await 结束后仍未收尾）').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('对照：AbortSignal（既有通路，防回归）', async () => {
    const { client, dispose, state } = await setup();
    try {
      const ac = new AbortController();
      const sh = await client.serverStream('tick', { input: {}, meta: {} }, { signal: ac.signal });
      const it = sh[Symbol.asyncIterator]();
      await it.next();
      ac.abort();
      await expectSettled(state, 'AbortSignal');
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  取消终态矩阵（任务 185）：abort / dispose / 半关 的规范落定 + 三传输一致
// ═══════════════════════════════════════════════════

describe.each(harnesses.map((h) => [h.name, h] as const))('取消终态矩阵: %s', (_name, h) => {
  const params = { input: {}, meta: {} };

  it('bidi 输入半关（end）≠ 取消：服务端跑完、客户端干净收流', async () => {
    const { binding, client, dispose } = await h.start();
    const state = { finallyRan: false, sawInputDone: false, got: [] as number[] };
    binding.on(api.echo, async function* ({ stream }) {
      try {
        for await (const c of stream) {
          state.got.push(c as number);
          yield c; // 回显
        }
        state.sawInputDone = true; // 输入干净结束（未被当成取消）
        yield 100; // 半关后仍产出：协议常态
        yield 101;
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      async function* ups() {
        yield 1;
        yield 2; // 自然结束 = 输入半关（发 end，不发 cancel）
      }
      const sh = await client.bidiStream('echo', params, ups());
      const out: number[] = [];
      for await (const v of sh) out.push(v as number);
      expect(state.got, '服务端未收齐输入').toEqual([1, 2]);
      expect(state.sawInputDone, '输入 end 被当成了取消（半关语义丢失）').toBe(true);
      expect(out, '输入半关后服务端产出丢失').toEqual([1, 2, 100, 101]);
      expect(state.finallyRan).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('bidi abort → 客户端 CANCELLED、服务端生成器收尾', async () => {
    const { binding, client, dispose } = await h.start();
    const state: TickState & { got: number[] } = { finallyRan: false, yields: 0, got: [] };
    binding.on(api.echo, async function* ({ stream }) {
      try {
        for await (const c of stream) {
          state.got.push(c as number);
          state.yields++;
          yield c;
        }
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const ac = new AbortController();
      // 输入源：打开后永不产出也不结束（服务端挂起在输入循环）。刻意不用 generator：
      // 空循环体会触发 require-yield lint，而产出任何 chunk 都会改变服务端状态
      const idle: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<number>>(() => { /* 永挂 */ }),
        }),
      };
      const sh = await client.bidiStream('echo', params, idle, { signal: ac.signal });
      const it = sh[Symbol.asyncIterator]();
      const pending = it.next(); // 服务端无产出 → 挂起
      ac.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      await expectSettled(state, 'bidi abort');
    } finally {
      await dispose();
    }
  });

  it('clientStream abort → 客户端 reject CANCELLED（统一终态，不再干净 resolve）', async () => {
    const { binding, client, dispose } = await h.start();
    const state = { finallyRan: false, received: 0 };
    binding.on(api.drain, async ({ stream }) => {
      try {
        for await (const _ of stream) state.received++;
        return state.received;
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const ac = new AbortController();
      async function* ups() {
        for (let i = 0; ; i++) {
          yield i;
          await sleep(5);
        }
      }
      const p = client.clientStream('drain', params, ups(), { signal: ac.signal });
      expect(await waitFor(() => state.received >= 2), '服务端未收到输入').toBe(true);
      ac.abort();
      // 旧行为：channel 干净 resolve / http 取决于 handler —— 现统一 reject CANCELLED
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await waitFor(() => state.finallyRan), 'abort 后服务端未收尾').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('unary abort → handler 收到 opts.signal（signal 可达 handler）', async () => {
    const { binding, client, dispose } = await h.start();
    const state = { started: false, observed: false };
    binding.on(api.wait, ({ signal }) =>
      new Promise<boolean>((_res, rej) => {
        state.started = true;
        signal.addEventListener(
          'abort',
          () => {
            state.observed = true;
            rej(signal.reason);
          },
          { once: true },
        );
      }),
    );
    try {
      const ac = new AbortController();
      const p = client.invoke('wait', params, { signal: ac.signal });
      expect(await waitFor(() => state.started), 'handler 未启动').toBe(true);
      ac.abort(new RpcError('CANCELLED', 'user cancelled'));
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED', message: 'user cancelled' });
      expect(await waitFor(() => state.observed), 'signal 不可达 unary handler').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('dispose-after-ack → 客户端 DISPOSED（统一终态，不再干净 done）', async () => {
    const { binding, client, dispose } = await h.start();
    const state: TickState = { finallyRan: false, yields: 0 };
    binding.on(api.tick, async function* () {
      try {
        for (let i = 0; ; i++) {
          state.yields++;
          yield i;
          await sleep(5);
        }
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const sh = await client.serverStream('tick', params);
      const it = sh[Symbol.asyncIterator]();
      await it.next();
      client.dispose();
      // 旧分叉：channel → DISPOSED、http → 干净 done；现统一 DISPOSED
      await expect(it.next()).rejects.toMatchObject({ code: 'DISPOSED' });
      await expectSettled(state, 'dispose-after-ack');
    } finally {
      await dispose();
    }
  });

  it('ack 窗口 abort（调用返回即取消）→ CANCELLED + 服务端不白跑', async () => {
    const { binding, client, dispose } = await h.start();
    const state: TickState & { started: boolean } = { finallyRan: false, yields: 0, started: false };
    binding.on(api.tick, async function* () {
      state.started = true;
      try {
        for (let i = 0; ; i++) {
          state.yields++;
          yield i;
          await sleep(5);
        }
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const ac = new AbortController();
      const p = client.serverStream('tick', params, { signal: ac.signal });
      ac.abort(); // init 已在途、ack 未回：旧实现此时取消会丢失（任务 185 探针）
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      // handler 要么没起跑、要么已收尾；产出必须冻结（贴近「上游白跑」的用户症状）
      await sleep(150);
      const frozen = state.yields;
      await sleep(120);
      expect(state.yields, 'ack 窗口取消后服务端仍在产出').toBe(frozen);
      expect(state.finallyRan || !state.started, 'handler 起跑了但未收尾（白跑）').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('dispose-before-ack → DISPOSED（不再挂起）', async () => {
    const { binding, client, dispose } = await h.start();
    binding.on(api.slowOne, async () => {
      await sleep(120);
      return true;
    });
    try {
      const p = client.invoke('slowOne', params);
      client.dispose();
      // 旧 http 在此永久挂起（firstResponseStatus 无 settle 兜底）——现两传输统一 DISPOSED
      await expect(p).rejects.toMatchObject({ code: 'DISPOSED' });
    } finally {
      await dispose();
    }
  });

  it('signal.reason 透传：RpcError 保留 code/message，string → CANCELLED+message', async () => {
    const { binding, client, dispose } = await h.start();
    binding.on(api.slowOne, async () => {
      await sleep(80);
      return true;
    });
    try {
      const ac1 = new AbortController();
      const p1 = client.invoke('slowOne', params, { signal: ac1.signal });
      ac1.abort(new RpcError('DEADLINE_EXCEEDED', 'deadline 5ms'));
      await expect(p1).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED', message: 'deadline 5ms' });

      const ac2 = new AbortController();
      const p2 = client.invoke('slowOne', params, { signal: ac2.signal });
      ac2.abort('boom');
      await expect(p2).rejects.toMatchObject({ code: 'CANCELLED', message: 'boom' });

      const ac3 = new AbortController();
      const p3 = client.invoke('slowOne', params, { signal: ac3.signal });
      ac3.abort();
      await expect(p3).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await dispose();
    }
  });

  it('共享 signal：全部调用落定后 abort listener 归零（不泄漏闭包）', async () => {
    const { binding, client, dispose } = await h.start();
    binding.on(api.ok, async () => true);
    binding.on(api.finite, async function* ({ input }) {
      for (let i = 0; i < input.n; i++) yield i;
    });
    try {
      const ac = new AbortController();
      for (let i = 0; i < 3; i++) {
        await client.invoke('ok', params, { signal: ac.signal });
      }
      const sh = await client.serverStream('finite', { input: { n: 3 }, meta: {} }, { signal: ac.signal });
      for await (const _ of sh) {
        // 自然消费完（end 路径的 listener 清理）
      }
      // Node v24 默认不发 MaxListenersExceededWarning —— 必须直接数 listener（任务 185）
      expect(getEventListeners(ac.signal, 'abort'), '落定后仍挂着 abort listener').toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});

// ═══════════════════════════════════════════════════
//  Review 修复回归（2026-09-29：深度审查/R3 报告逐条处置后的验收）
// ═══════════════════════════════════════════════════

/** 永挂的上游：next() 永不 settle —— 验证调用落定不被不可取消的 next() 拖住 */
function hangingIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<T>>(() => { /* 永挂 */ }),
    }),
  };
}

describe('Review修复回归（2026-09-29）', () => {
  const params = { input: {}, meta: {} };

  it('channel: clientStream init timeout 不再误删 ack 后的结果 entry（P1）', async () => {
    const { binding, client, dispose } = await channelHarness.start();
    binding.on(api.drain, async ({ stream }) => {
      for await (const _ of stream) { /* 吃到 end */ }
      await sleep(200); // 结果晚于 init timeout
      return 7;
    });
    try {
      async function* ups() { yield 1; }
      const p = client.clientStream('drain', params, ups(), { timeout: 80 });
      // 修复前：ack 后旧 timer 仍活，到点删结果 entry → 结果被丢、永挂（probe3 TIMEOUT）
      await expect(p).resolves.toBe(7);
    } finally {
      await dispose();
    }
  });

  it.each([
    ['channel(in-memory)', channelHarness],
    ['http2', httpHarness],
  ] as const)('%s: 上游 next() 永挂时 abort → 立即 CANCELLED、服务端收尾（P1）', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const state = { started: false, finallyRan: false };
    binding.on(api.drain, async ({ stream }) => {
      state.started = true;
      try {
        for await (const _ of stream) { /* 挂在输入 */ }
      } finally {
        state.finallyRan = true;
      }
      return 0;
    });
    try {
      const ac = new AbortController();
      const p = client.clientStream('drain', params, hangingIterable<number>(), { signal: ac.signal });
      expect(await waitFor(() => state.started), 'handler 未启动').toBe(true);
      ac.abort();
      // 修复前：上传循环卡在 next() → 调用永挂（resultPromise 已 reject 也到不了 return）
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await waitFor(() => state.finallyRan), '服务端未收尾').toBe(true);
    } finally {
      await dispose();
    }
  });

  it.each([
    ['channel(in-memory)', channelHarness],
    ['http2', httpHarness],
  ] as const)('%s: clientStream 上传中 dispose → DISPOSED + 服务端收尾（P3 覆盖缺口）', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const state = { received: 0, finallyRan: false };
    binding.on(api.drain, async ({ stream }) => {
      try {
        for await (const _ of stream) state.received++;
        return state.received;
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const p = client.clientStream('drain', params, (async function* () {
        for (let i = 0; ; i++) { yield i; await sleep(5); }
      })());
      expect(await waitFor(() => state.received >= 2)).toBe(true);
      client.dispose();
      await expect(p).rejects.toMatchObject({ code: 'DISPOSED' });
      expect(await waitFor(() => state.finallyRan), 'dispose 后服务端未收尾').toBe(true);
    } finally {
      await dispose();
    }
  });

  it.each([
    ['channel(in-memory)', channelHarness],
    ['http2', httpHarness],
  ] as const)('%s: bidi 上传中 dispose → 消费端 DISPOSED + 服务端收尾（P3 覆盖缺口）', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    const state = { got: 0, finallyRan: false };
    binding.on(api.echo, async function* ({ stream }) {
      try {
        for await (const c of stream) { state.got++; yield c; }
      } finally {
        state.finallyRan = true;
      }
    });
    try {
      const sh = await client.bidiStream('echo', params, (async function* () {
        for (let i = 0; ; i++) { yield i; await sleep(5); }
      })());
      const iter = sh[Symbol.asyncIterator]();
      await iter.next(); // 收到回显 → 双向都在跑
      expect(await waitFor(() => state.got >= 2)).toBe(true);
      client.dispose();
      await expect(iter.next()).rejects.toMatchObject({ code: 'DISPOSED' });
      expect(await waitFor(() => state.finallyRan), 'dispose 后服务端未收尾').toBe(true);
    } finally {
      await dispose();
    }
  });

  it.each([
    ['channel(in-memory)', channelHarness],
    ['http2', httpHarness],
  ] as const)('%s: 未知方法/模式不匹配 → UNIMPLEMENTED（P2，不再永久 pending）', async (_n, h) => {
    const { client, dispose } = await h.start();
    try {
      await expect(client.invoke('nope', params)).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
      await expect(client.serverStream('nope', params)).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
    } finally {
      await dispose();
    }
  });

  it('http: client-stream 取消 → 只监听 signal（不消费输入）的 handler 也收到 abort（P1）', async () => {
    const { binding, client, dispose } = await httpHarness.start();
    const state = { started: false, observed: false };
    // 审查指出的 handler 形态：完全不消费 incoming，只依赖 opts.signal
    binding.on(api.drain, ({ signal }) => new Promise<number>((_res, rej) => {
      state.started = true;
      signal.addEventListener('abort', () => {
        state.observed = true;
        rej(signal.reason);
      }, { once: true });
    }));
    try {
      const ac = new AbortController();
      const p = client.clientStream('drain', params, hangingIterable<number>(), { signal: ac.signal });
      expect(await waitFor(() => state.started)).toBe(true);
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await waitFor(() => state.observed), '__cancel/RST 未触发 handler signal').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('channel: legacy 兼容 —— 旧 client 的 server-stream「end=取消」仍被接收（P2）', async () => {
    const [txServer, txClient] = createMemTransportPair();
    const binding = new ChannelServerBinding(txServer);
    const state: TickState & { acked: boolean } = { finallyRan: false, yields: 0, acked: false };
    binding.on(api.tick, async function* () {
      try {
        for (let i = 0; ; i++) { state.yields++; yield i; await sleep(5); }
      } finally {
        state.finallyRan = true;
      }
    });
    // 模拟旧协议 client：call → 收 ack → 发 end（旧语义：end = 取消），不发 cancel 帧
    const sidP = new Promise<number>((resolve) => {
      txClient.on((msg) => {
        const m = msg as { type: string; stream?: number };
        if (m.type === 'call' && m.stream != null) { state.acked = true; resolve(m.stream); }
      });
    });
    txClient.send({ type: 'call', id: 1, method: 'tick', params: { input: {} }, stream: true });
    const sid = await sidP;
    txClient.send({ type: 'end', stream: sid });
    // 修复前：end 对 server-stream 无人认领 → 忽略 → 白跑（yields 持续增长）
    expect(await waitFor(() => state.finallyRan), 'legacy end 未被接收，服务端白跑').toBe(true);
    const frozen = state.yields;
    await sleep(80);
    expect(state.yields).toBe(frozen);
  });

  it.each([
    ['channel(in-memory)', channelHarness],
    ['http2', httpHarness],
  ] as const)('%s: 挂起调用 abort 终态后共享 signal 的 listener 归零（P1 清理补断言）', async (_n, h) => {
    const { binding, client, dispose } = await h.start();
    binding.on(api.wait, () => new Promise<boolean>(() => { /* 永挂 */ }));
    try {
      const ac = new AbortController();
      const p = client.invoke('wait', params, { signal: ac.signal });
      await sleep(20); // 确保 listener 已注册
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(getEventListeners(ac.signal, 'abort'), 'abort 终态后仍挂着 listener').toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});
