// tests/core/restart-gate.test.ts — 热重启让位（##404）
//
// 压的是判据，不是接线：
//   ① 空闲 ⇒ `deferred: false`（调用方照常立刻退，零延迟）
//   ② 有轮次 ⇒ 不退；等它结束才 `quit`（这就是「改 src 不再砍自己的轮次」的全部实现）
//   ③ 超时 ⇒ 照退，**且留痕**（挂死的轮次不许把热重启永久拖住）
//   ④ 轮询期间 quit 只发生一次（多轮在跑时退出事件不许重复触发）
import { describe, expect, it } from "vitest";
import { deferQuitUntilIdle } from "../../src/main/core/restart-gate";

/** 可控调度器：`advance()` 让排到的定时器触发一次（不真等） */
function scheduler() {
  let queue: Array<() => void> = [];
  return {
    setTimer: (fn: () => void): unknown => {
      queue.push(fn);
      return queue.length;
    },
    /** 跑掉当前排队的定时器（模拟时间前进一个 poll 周期） */
    advance(): void {
      const run = queue;
      queue = [];
      for (const fn of run) fn();
    },
    get pending(): number {
      return queue.length;
    },
  };
}

describe("deferQuitUntilIdle", () => {
  it("空闲 ⇒ 立刻退（不推迟、不排定时器）", () => {
    const s = scheduler();
    const quits: string[] = [];
    const v = deferQuitUntilIdle({ activeTurns: () => [], quit: (why) => quits.push(why), setTimer: s.setTimer });
    expect(v).toEqual({ deferred: false });
    expect(quits).toEqual([]); // 空闲时由调用方退 —— 本函数不许替它退
    expect(s.pending).toBe(0);
  });

  it("有轮次 ⇒ 先不退；轮次结束后才退", () => {
    const s = scheduler();
    const quits: string[] = [];
    let busy = [{ taskUri: "projects/1/tasks/5" }];
    const v = deferQuitUntilIdle({
      activeTurns: () => busy,
      quit: (why) => quits.push(why),
      setTimer: s.setTimer,
      pollMs: 1000,
    });
    expect(v).toEqual({ deferred: true, waiting: ["projects/1/tasks/5"] });
    s.advance(); // 仍在跑
    expect(quits).toEqual([]);
    busy = [];
    s.advance(); // 跑完了
    expect(quits).toEqual(["轮次已结束"]);
  });

  it("让位超时 ⇒ 照退，并把「超时」写进日志（不许静默砍轮次）", () => {
    const s = scheduler();
    const quits: string[] = [];
    const logs: string[] = [];
    let t = 0;
    const v = deferQuitUntilIdle({
      activeTurns: () => [{ taskUri: "projects/1/tasks/5" }],
      quit: (why) => quits.push(why),
      log: (l) => logs.push(l),
      setTimer: s.setTimer,
      maxWaitMs: 3000,
      pollMs: 1000,
      now: () => t,
    });
    expect(v.deferred).toBe(true);
    t = 3000;
    s.advance();
    expect(quits).toEqual(["让位超时，仍有 1 轮在跑"]);
    expect(logs.some((l) => l.includes("让位超时"))).toBe(true);
  });

  it("退出只在一次让位里发生一次（不许双触发）", () => {
    const s = scheduler();
    const quits: string[] = [];
    let busy = [{ taskUri: "a" }, { taskUri: "b" }];
    deferQuitUntilIdle({ activeTurns: () => busy, quit: (w) => quits.push(w), setTimer: s.setTimer });
    busy = [];
    s.advance();
    s.advance(); // 已 settled：再触发也不该再 quit（不会有新的定时器，这里靠 no-op 兜底）
    expect(quits).toHaveLength(1);
  });
});
