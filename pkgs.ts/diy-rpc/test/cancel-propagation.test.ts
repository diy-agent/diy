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
 * 参数化到 channel 与 http 两条真实链路：renderer↔main 走 channel（Electron IPC），
 * CLI↔app 走 http2 —— 149 的故障发生在 channel 侧。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { channelHarness, httpHarness, type TransportHarness } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = RpcSchema.router({
  tick: RpcSchema.serverStream({ input: {}, output: z.number() }),
  /** 产出一次后挂在长 await：用于区分「只设取消标志」与「真正终结生成器」 */
  slow: RpcSchema.serverStream({ input: {}, output: z.number() }),
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

const harnesses: TransportHarness[] = [channelHarness, httpHarness];

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
