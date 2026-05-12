/**
 * Scheduler 单元测试
 * 验证：去重、深度排序
 */

import { describe, it, expect, vi } from "vitest";
import { ImmediateScheduler, PeriodicScheduler, type CellRef } from "../src/scheduler.js";

function makeCellRef(name: string, depth: number): CellRef {
  return {
    rerun: vi.fn(),
    getDepth: () => depth,
    _name: name,
  } as CellRef & { _name: string };
}

describe("ImmediateScheduler", () => {
  it("schedule 应立即执行 rerun", () => {
    const s = new ImmediateScheduler();
    const cell = makeCellRef("a", 0);

    s.schedule(cell);
    expect(cell.rerun).toHaveBeenCalledTimes(1);
  });

  it("多次 schedule 应立即执行每个", () => {
    const s = new ImmediateScheduler();
    const cell = makeCellRef("a", 0);

    s.schedule(cell);
    s.schedule(cell);
    s.schedule(cell);
    expect(cell.rerun).toHaveBeenCalledTimes(3);
  });

  it("flush 应为 noop", () => {
    const s = new ImmediateScheduler();
    // 不应抛出
    s.flush();
  });
});

describe("PeriodicScheduler", () => {
  it("schedule 不应立即执行", () => {
    const s = new PeriodicScheduler(1000); // 长周期
    const cell = makeCellRef("a", 0);

    s.schedule(cell);
    expect(cell.rerun).not.toHaveBeenCalled();
    s.dispose();
  });

  it("flush 应执行所有脏 cell", () => {
    const s = new PeriodicScheduler(1000);
    const a = makeCellRef("a", 0);
    const b = makeCellRef("b", 1);

    s.schedule(a);
    s.schedule(b);
    s.flush();

    expect(a.rerun).toHaveBeenCalledTimes(1);
    expect(b.rerun).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("应对同一 cell 去重", () => {
    const s = new PeriodicScheduler(1000);
    const a = makeCellRef("a", 0);

    s.schedule(a);
    s.schedule(a);
    s.schedule(a);
    s.flush();

    expect(a.rerun).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("应按深度排序（浅层先执行）", () => {
    const s = new PeriodicScheduler(1000);
    const order: string[] = [];

    const deep = {
      rerun: () => order.push("deep"),
      getDepth: () => 5,
    };
    const shallow = {
      rerun: () => order.push("shallow"),
      getDepth: () => 1,
    };
    const mid = {
      rerun: () => order.push("mid"),
      getDepth: () => 3,
    };

    s.schedule(deep);
    s.schedule(shallow);
    s.schedule(mid);
    s.flush();

    expect(order).toEqual(["shallow", "mid", "deep"]);
    s.dispose();
  });

  it("flush 后脏集合应为空", () => {
    const s = new PeriodicScheduler(1000);
    const a = makeCellRef("a", 0);

    s.schedule(a);
    s.flush();
    expect(a.rerun).toHaveBeenCalledTimes(1);

    // 第二次 flush 不应再执行
    a.rerun.mockClear();
    s.flush();
    expect(a.rerun).not.toHaveBeenCalled();
    s.dispose();
  });

  it("dispose 应停止定时器", () => {
    const s = new PeriodicScheduler(1000);
    s.dispose();
    // 不应抛出
    s.dispose();
  });
});
