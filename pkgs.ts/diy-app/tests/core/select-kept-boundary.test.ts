// tests/core/select-kept-boundary.test.ts
// ##442 最大精简：一个保留比例 + 一条切点规则（从尾装够 → 挪到 user）。
import { describe, expect, it } from "vitest";
import {
    RETAIN_RATIO,
    TRIGGER_RESERVE_MIN,
    hasDropped,
    retainTokensOf,
    selectKeptBoundary,
    triggerTokensOf,
} from "../../src/shared/context/select-kept-boundary";

const msg = (tokens: number, user = false) => ({ tokens, user });

describe("两个派生量（零旋钮）", () => {
    it("保留量 = 窗口 × 0.16（三档窗口）", () => {
        expect(RETAIN_RATIO).toBe(0.16);
        expect(retainTokensOf(128_000)).toBe(20_480);
        expect(retainTokensOf(256_000)).toBe(40_960);
        expect(retainTokensOf(1_000_000)).toBe(160_000);
    });

    it("触发线 = 窗口 − max(10%, 16k)", () => {
        expect(triggerTokensOf(1_000_000)).toBe(900_000);
        expect(triggerTokensOf(256_000)).toBe(230_400);
        // 小窗口：16k 兜底比 10% 大
        expect(triggerTokensOf(128_000)).toBe(112_000);
        expect(triggerTokensOf(20_000)).toBe(4_000);
        expect(triggerTokensOf(0)).toBe(0);
    });
});

describe("选段：从尾装够 → 挪到最近 user", () => {
    it("尾段装够保留量后，切点落在 user（call/result 不可能被拆）", () => {
        // 10 条 × 400；偶数下标是 user
        const all = Array.from({ length: 10 }, (_, i) => msg(400, i % 2 === 0));
        const b = selectKeptBoundary(all, 3_200, 4_000);
        expect(b.kind).toBe("drop");
        // 从尾装 8 条 = 3200，i=2；2 是 user ⇒ cut=2
        expect(b.cut).toBe(2);
        expect(b.retainedTokens).toBe(3_200);
        expect(hasDropped(b)).toBe(true);
    });

    it("总量装得下（< 保留量）⇒ 不压", () => {
        const all = Array.from({ length: 4 }, (_, i) => msg(400, i % 2 === 0));
        expect(selectKeptBoundary(all, 3_200, 4_000).kind).toBe("none");
    });

    it("压完仍超触发线 ⇒ 不压（除手动 force）", () => {
        // 10 条 × 500；尾段装 7 条 = 3500 ≥ 保留 3200，但 3500 ≥ 触发线 3400 ⇒ 压了也没降下来
        const all = Array.from({ length: 10 }, (_, i) => msg(500, i % 2 === 0));
        expect(selectKeptBoundary(all, 3_200, 3_400).kind).toBe("none");
        expect(selectKeptBoundary(all, 3_200, 3_400, { force: true }).kind).toBe("drop");
    });

    it("切点找不到 user / 落在开头 ⇒ 不压", () => {
        expect(selectKeptBoundary([msg(10_000, false)], 3_200, 4_000).kind).toBe("none");
        expect(selectKeptBoundary([], 3_200, 4_000).kind).toBe("none");
    });

    it("保头不存在：第 1 条也可以被丢", () => {
        const all = [msg(100, true), ...Array.from({ length: 9 }, (_, i) => msg(1_000, i % 2 === 0))];
        const b = selectKeptBoundary(all, 3_200, 6_000);
        expect(b.cut).toBeGreaterThanOrEqual(1);
        expect(b.cut).not.toBe(0);
    });
});

describe("切点吸附轮首（消息级 ≡ 轮级）", () => {
    it("尾段切点落在轮中插话 ⇒ 回退到该轮第一条 user", () => {
        // turn a: 0-3；turn b: 4-9（4=开场 user，6=轮中插话）
        const all = Array.from({ length: 10 }, (_, i) => ({
            tokens: 500,
            user: i % 2 === 0,
            turn: i < 4 ? "a" : "b",
        }));
        const b = selectKeptBoundary(all, 1_500, 6_000);
        // 尾段装 3 条（7..9 = 1500）→ i=7 → 回退 user 6 → 再吸附轮首 4
        expect(b.cut).toBe(4);
    });

    it("没有 turn 字段时保持原行为（切到最近 user）", () => {
        const all = Array.from({ length: 10 }, (_, i) => ({ tokens: 500, user: i % 2 === 0 }));
        const b = selectKeptBoundary(all, 1_500, 6_000);
        expect(b.cut).toBe(6);
    });
});

describe("小窗口兜底值", () => {
    it("16k 是预留下限（不是保头）", () => {
        expect(TRIGGER_RESERVE_MIN).toBe(16_000);
    });
});
