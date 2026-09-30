/**
 * 实现级资源回归（review R12/R13）：HTTP 传输「调用终态后 request-side 必须收束」。
 *
 * 观测面：HttpClientBinding.activeStreams（内部集合）。意图/语义契约在
 * intent.cancel.test.ts；本文件钉住的是 HTTP/2 半开流与背压悬挂这两类
 * 资源生命周期回归——黑盒接口无法表达，故直接用实现级观测。
 *
 * 背景：远端终态（clientStream result / bidi 队列结束）后仅停写会留下
 * writableEnded=false 的半开 request stream，滞留 activeStreams 直到 dispose；
 * 背压（write 返回 false）时上传协程还可能永久挂在 drain 等待。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { httpHarness } from './harness';
import { RpcSchema } from '../src/core/rpc';
import { createTypedClient } from '../src/core/typed-client';

const api = RpcSchema.router({
  collect: RpcSchema.clientStream({
    input: { tag: z.string() },
    chunkIn: z.number(),
    output: z.object({ tag: z.string(), sum: z.number() }),
  }),
  chat: RpcSchema.bidiStream({ input: { room: z.string() }, chunkIn: z.string(), chunkOut: z.string() }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeout = 2000, step = 10): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

/** 观测 HttpClientBinding 的活动流集合（实现级） */
function activeStreams(client: unknown): Set<unknown> {
  return (client as unknown as { activeStreams: Set<unknown> }).activeStreams;
}

/** 永挂（或快速产出）的可观测上游迭代器 */
function trackedUpstream<T>(s: { next: number; ret: number }, make: (n: number) => IteratorResult<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        s.next++;
        const r = make(s.next);
        if (r.done) return r;
        if (r.value === HANG) return new Promise<IteratorResult<T>>(() => {});
        return r;
      },
      return: async () => {
        s.ret++;
        return { done: true as const, value: undefined };
      },
    }),
  };
}
const HANG = Symbol('hang');

describe('HTTP 资源收束（实现级，review R12/R13）', () => {
  it('clientStream：远端终态后 request stream 收敛（不半开滞留）', async () => {
    const { binding, client, dispose } = await httpHarness.start();
    const cli = createTypedClient(client, api);
    binding.on(api.collect, async () => ({ tag: 'x', sum: 0 }));
    // 上游永挂：调用落定不得依赖上传完成
    const s = { next: 0, ret: 0 };
    const iter = trackedUpstream<number>(s, () => ({ done: false, value: HANG as unknown as number }));
    try {
      await cli.collect({ tag: 'x' }, iter);
      expect(await waitFor(() => activeStreams(client).size === 0), '终态后 request stream 未收敛（半开滞留）').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('bidiStream：远端终态后 request stream 收敛（不半开滞留）', async () => {
    const { binding, client, dispose } = await httpHarness.start();
    const cli = createTypedClient(client, api);
    binding.on(api.chat, async function* () {
      /* 立即结束 */
    });
    const s = { next: 0, ret: 0 };
    const iter = trackedUpstream<string>(s, () => ({ done: false, value: HANG as unknown as string }));
    try {
      const stream = await cli.chat({ room: 'r' }, iter);
      for await (const _v of stream) {
        /* 消费到远端结束 */
      }
      expect(await waitFor(() => activeStreams(client).size === 0), '终态后 request stream 未收敛（半开滞留）').toBe(true);
    } finally {
      await dispose();
    }
  });

  it('背压（write 返回 false）后远端终态：流收敛且上游收到终止通知', async () => {
    const { binding, client, dispose } = await httpHarness.start();
    const cli = createTypedClient(client, api);
    binding.on(api.collect, async () => ({ tag: 'bp', sum: 0 }));
    const s = { next: 0, ret: 0 };
    const big = 'x'.repeat(8192);
    // 快速产出填满流控窗口 → write 返回 false → 上传协程挂在 drain 等待
    const iter = trackedUpstream<string>(s, () => ({ done: false, value: big }));
    try {
      await (cli.collect as unknown as (p: { tag: string }, i: AsyncIterable<string>) => Promise<unknown>)({ tag: 'bp' }, iter);
      expect(s.next, '未触发背压：上游应出产超过流控窗口的数据').toBeGreaterThan(1);
      expect(await waitFor(() => activeStreams(client).size === 0), '背压悬挂：终态后 request stream 未收敛').toBe(true);
      expect(s.ret, '终态后上游未收到 return 通知').toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it('R16：write=false 后永无 drain，远端终态唤醒 → 不得再拉取上游', async () => {
    const { binding, client, dispose } = await httpHarness.start();
    const cli = createTypedClient(client, api);
    binding.on(api.collect, async () => ({ tag: 'x', sum: 0 }));
    // 强制第一次大写入返回 false 且永无 drain：唤醒只能来自远端终态的 close。
    // 未修复实现：onceDrain 被 close 唤醒后回到 for 顶部再次 upstream.next()，
    // 第二次拉取永挂 → 后台上传协程悬挂（R16 P1）。
    const state = { forced: false, forcedCount: 0 };
    const runtime = client as unknown as {
      request: (...args: unknown[]) => { write: (chunk: string) => boolean };
    };
    const originalRequest = runtime.request.bind(client);
    runtime.request = ((...args: unknown[]) => {
      const stream = originalRequest(...args) as { write: (chunk: string) => boolean };
      const write = stream.write.bind(stream);
      stream.write = ((chunk: string) => {
        const ok = write(chunk);
        if (!state.forced && String(chunk).length > 1000) {
          state.forced = true;
          state.forcedCount++;
          return false; // 背压信号，但不产生 drain 事件
        }
        return ok;
      }) as typeof stream.write;
      return stream;
    }) as typeof runtime.request;
    const s = { next: 0, ret: 0 };
    const iter = trackedUpstream<string>(s, (n) =>
      n === 1 ? { done: false, value: 'x'.repeat(4096) } : { done: false, value: HANG as unknown as string },
    );
    try {
      const resp = (await (cli.collect as unknown as (p: { tag: string }, i: AsyncIterable<string>) => Promise<{ tag: string }>)({ tag: 'x' }, iter)) as { tag: string };
      expect(resp.tag).toBe('x');
      expect(state.forcedCount, '未进入强制背压窗口（write 未被强制 false）').toBe(1);
      await sleep(300); // 给未修复实现发起第二次拉取的时间（R16 probe 同口径）
      expect(s.next, 'drain 被终态唤醒后又拉取了上游（R16 P1 回归）').toBe(1);
      expect(s.ret, '终态后上游未收到 return 通知').toBeGreaterThan(0);
      expect(await waitFor(() => activeStreams(client).size === 0), '背压终态后 request stream 未收敛').toBe(true);
    } finally {
      await dispose();
    }
  });
});
