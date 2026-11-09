// tests/core/frame-batch.test.ts — 「RO 写操作延到下一帧」的批处理原语（##522）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameBatcher } from "../../src/renderer_solid/lib/frame-batch";

/** 手动驱动的 rAF：测试里显式 flush 一帧，不依赖真实渲染循环 */
let queue: FrameRequestCallback[] = [];
let nextId = 1;

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue = queue.filter((_, i) => i + 1 !== id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = () => {
  const q = queue;
  queue = [];
  for (const cb of q) cb(0);
};

describe("createFrameBatcher", () => {
  it("同帧多次 schedule 只跑一次（合并）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run);
    b.schedule();
    b.schedule();
    b.schedule();
    expect(run).not.toHaveBeenCalled(); // 本帧不跑：跑在回调里就是循环本身
    flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("下一帧可以重新排（id 在 run 前就清空）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run);
    b.schedule();
    flush();
    b.schedule();
    flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel 后不跑（卸载路径：run 不许打到已卸载的 ref）", () => {
    const run = vi.fn();
    const b = createFrameBatcher(run);
    b.schedule();
    b.cancel();
    flush();
    expect(run).not.toHaveBeenCalled();
    b.schedule(); // cancel 之后仍可再用
    flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
