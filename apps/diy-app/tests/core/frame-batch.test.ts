// tests/core/frame-batch.test.ts — 「RO 写操作延到下一帧」的批处理原语（##522）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameBatcher } from "../../src/renderer_solid/lib/frame-batch";

/** 手动驱动的 rAF / setTimeout：测试里显式「过一帧」或「过兜底时间」，不依赖真实调度 */
let raf = new Map<number, FrameRequestCallback>();
let timers = new Map<number, () => void>();
let nextId = 1;

beforeEach(() => {
  raf = new Map();
  timers = new Map();
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    raf.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    raf.delete(id);
  });
  vi.stubGlobal("setTimeout", (cb: () => void) => {
    const id = nextId++;
    timers.set(id, cb);
    return id;
  });
  vi.stubGlobal("clearTimeout", (id: number) => {
    timers.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 过一帧：执行当前排队的 rAF 回调 */
const flushFrame = () => {
  const q = [...raf.values()];
  raf.clear();
  for (const cb of q) cb(0);
};

/** 过兜底时间：执行当前排队的定时器 */
const flushTimer = () => {
  const q = [...timers.values()];
  timers.clear();
  for (const cb of q) cb();
};

describe("createFrameBatcher", () => {
  it("同帧多次 schedule 只跑一次（合并）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run);
    b.schedule();
    b.schedule();
    b.schedule();
    expect(run).not.toHaveBeenCalled(); // 本帧不跑：跑在回调里就是循环本身
    flushFrame();
    expect(run).toHaveBeenCalledTimes(1);
    flushTimer(); // 已经被 rAF 执行过：兜底定时器要清掉，不能重复跑
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("下一帧可以重新排（id 在 run 前就清空）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run);
    b.schedule();
    flushFrame();
    b.schedule();
    flushFrame();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel 后不跑（卸载路径：run 不许打到已卸载的 ref）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run);
    b.schedule();
    b.cancel();
    flushFrame();
    flushTimer();
    expect(run).not.toHaveBeenCalled();
    b.schedule(); // cancel 之后仍可再用
    flushFrame();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rAF 被节流/暂停时，兜底定时器到点照样执行（回归：卡住很久才恢复）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run, { fallbackMs: 120 });
    b.schedule();
    expect(run).not.toHaveBeenCalled();
    flushTimer(); // 模拟 rAF 一直没来
    expect(run).toHaveBeenCalledTimes(1);
    flushFrame(); // 兜底执行过之后，rAF 再来一次不该重复跑
    expect(run).toHaveBeenCalledTimes(1);
  });
});
