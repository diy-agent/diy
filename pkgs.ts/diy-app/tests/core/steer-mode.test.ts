// tests/core/steer-mode.test.ts
// 🎯 插话投递时机的展示层归一（UI 读 ops 日志 meta 时用）
//
// 值域由**历史日志**决定：枚举改名前的 `step` / `turn` 与新值长期共存于 append-only 的
// ops.jsonl。不归一 → 旧的 `step` 落进 else → 显示成「下一轮」，语义正好相反。

import { describe, it, expect } from "vitest";
import { normalizeSteerMode, steerModeLabel, steerModeTip } from "../../src/shared/steer-mode";

describe("normalizeSteerMode", () => {
  it("历史枚举名 step/turn → 现值 next-step/next-turn", () => {
    expect(normalizeSteerMode("step")).toBe("next-step");
    expect(normalizeSteerMode("turn")).toBe("next-turn");
  });

  it("现值原样返回（幂等）", () => {
    expect(normalizeSteerMode("next-step")).toBe("next-step");
    expect(normalizeSteerMode("next-turn")).toBe("next-turn");
  });

  it("认不出的值原样呈现（不猜、不默认成某一侧）", () => {
    // 猜错的代价是把"下一步"显示成"下一轮"——比显示一个怪名字更糟
    expect(normalizeSteerMode("step-x")).toBe("step-x");
    expect(normalizeSteerMode("")).toBe("");
    expect(normalizeSteerMode("Step")).toBe("Step");
  });
});

describe("steerModeLabel", () => {
  it("说出投递时机本身，而不是内部枚举名", () => {
    expect(steerModeLabel("next-step")).toBe("下一步");
    expect(steerModeLabel("next-turn")).toBe("下一轮");
  });

  it("历史值同样归一到人话（改名前的日志也要读得懂）", () => {
    expect(steerModeLabel("step")).toBe("下一步");
    expect(steerModeLabel("turn")).toBe("下一轮");
  });

  it("认不出的值原样显示（难看但不说谎）", () => {
    expect(steerModeLabel("weird")).toBe("weird");
  });
});

describe("steerModeTip", () => {
  it("next-step 的说明点出降级（本轮已收尾 → 成为下一轮开场）", () => {
    const tip = steerModeTip("next-step");
    expect(tip).toContain("下一步");
    expect(tip).toContain("本轮已收尾");
  });

  it("next-turn 的说明是「本轮跑完接着开新一轮」", () => {
    expect(steerModeTip("next-turn")).toContain("新一轮");
  });

  it("历史值与现值给同一份说明（不会因日志新旧而说法不同）", () => {
    expect(steerModeTip("step")).toBe(steerModeTip("next-step"));
    expect(steerModeTip("turn")).toBe(steerModeTip("next-turn"));
  });

  it("认不出的值不给说明（不编造不存在的时机）", () => {
    expect(steerModeTip("weird")).toBe("");
  });
});
