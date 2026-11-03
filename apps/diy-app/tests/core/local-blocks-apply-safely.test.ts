// tests/core/local-blocks-apply-safely.test.ts
// 🎯 批量应用 op 的**容错契约**（##377 第 15 刀 / ##166 §41.4 判据 3）
//
// 口径：**一条坏 op 不该吃掉它后面**的所有记录。
// 原来的调用方（渲染端 `applyInto`）是裸 `for (op of ops) store.apply(op)` —— 一条抛错就
// 中断整批、且没有任何日志；症状是"最新的几轮整段消失"，界面上与"模型还没回"完全同形。

import { describe, expect, it, vi } from "vitest";
import { BlockStore, applyOpsSafely, type Op } from "../../src/main/services/local-blocks";

const TURN = "t1";
const turnStart: Op = { op: "start", id: TURN, kind: "turn" };
const textStart: Op = { op: "start", id: "t1_t1", kind: "text", parent: TURN, meta: { role: "assistant" } };
const textDelta: Op = { op: "delta", id: "t1_t1", fields: { content: "你好" } };

/** 结构损坏的 op：`apply` 会在 `op.op` 上抛（未知块那类只记 issue、不抛） */
const broken = null as unknown as Op;

describe("applyOpsSafely", () => {
  it("全部正常：返回 0，块树按序建好", () => {
    const store = new BlockStore();
    const failed = applyOpsSafely(store, [turnStart, textStart, textDelta]);
    expect(failed).toBe(0);
    expect(store.blocks.get(TURN)?.kind).toBe("turn");
    expect(store.blocks.get("t1_t1")?.content).toBe("你好");
  });

  it("中间一条坏 op ⇒ **它后面的 op 仍被应用**（返回失败条数）", () => {
    const store = new BlockStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = applyOpsSafely(store, [turnStart, broken, textStart, textDelta]);
    warn.mockRestore();
    expect(failed).toBe(1);
    // 坏 op **之前**的照常
    expect(store.blocks.get(TURN)?.kind).toBe("turn");
    // 坏 op **之后**的也照常 —— 这条就是本契约的全部意义
    expect(store.blocks.get("t1_t1")?.content).toBe("你好");
  });

  it("坏 op 会出声（不是静默吞错）", () => {
    const store = new BlockStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    applyOpsSafely(store, [broken]);
    const calls = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(calls.some((m) => m.includes("op 应用失败"))).toBe(true);
    expect(calls.some((m) => m.includes("1/1"))).toBe(true);
  });

  it("进入时清掉旧的 fold issues（不让诊断信息无界堆积）", () => {
    const store = new BlockStore();
    store.apply(turnStart);
    store.apply(turnStart); // 重复 start ⇒ 记一条 issue
    expect(store.issues.length).toBeGreaterThan(0);
    applyOpsSafely(store, [textStart]);
    expect(store.issues.length).toBe(0);
  });
});
