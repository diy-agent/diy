// tests/core/chat-virtual.test.ts
// 视口虚拟化的纯逻辑（##301）：前缀和布局 / 窗口范围 / 高度账。
import { describe, it, expect } from "vitest";
import {
    HeightLedger,
    ROW_FALLBACK,
    ROW_GAP,
    bottomOf,
    stackRows,
    windowRange,
} from "../../src/renderer_solid/lib/chat-virtual";

describe("stackRows：前缀和布局", () => {
    it("顶边含行距、总高不含尾随行距（与 space-y 的几何一致）", () => {
        const { tops, total } = stackRows([100, 200, 50]);
        expect(tops).toEqual([0, 100 + ROW_GAP, 100 + ROW_GAP + 200 + ROW_GAP]);
        expect(total).toBe(100 + 200 + 50 + ROW_GAP * 2);
    });
    it("空列表总高 0；单行总高不含行距", () => {
        expect(stackRows([])).toEqual({ tops: [], total: 0 });
        expect(stackRows([100]).total).toBe(100);
    });
});

describe("windowRange：只挂视口附近的行", () => {
    // 10 行 × 100px（+12px 行距）⇒ 总高 1108
    const heights = Array.from({ length: 10 }, () => 100);
    const { tops } = stackRows(heights);

    it("空列表 → 空窗", () => {
        expect(windowRange([], [], 0, 500, 0)).toEqual([0, 0]);
    });

    it("视口覆盖整份 ⇒ 全量（不会多摘一行）", () => {
        expect(windowRange(tops, heights, 0, 5000, 0)).toEqual([0, 10]);
    });

    it("滚动到中段：窗口只含相交行（无 overscan）", () => {
        // scrollTop=500 ⇒ 视口 [500, 700)：第 4 行 top=448 bottom=548 相交，第 6 行 top=672 bottom=772 相交
        const [f, t] = windowRange(tops, heights, 500, 200, 0);
        expect(f).toBe(4);
        expect(t).toBe(7);
    });

    it("overscan 上下各扩一段，但不越界", () => {
        const [f, t] = windowRange(tops, heights, 500, 200, 300);
        expect(f).toBe(1); // 500-300=200 ⇒ 第 1 行（top=112,bottom=212）相交
        expect(t).toBe(9); // 700+300=1000 ⇒ 第 9 行 top=1008 > 1000 ⇒ 窗口止于第 8 行之后
    });

    it("滚到顶 / 到底：窗口贴边、至少一行", () => {
        expect(windowRange(tops, heights, 0, 100, 0)[0]).toBe(0);
        const [f, t] = windowRange(tops, heights, 100000, 100, 0);
        expect(t).toBe(10);
        expect(f).toBeLessThan(t); // 至少一行
    });

    it("窗口至少一行（全在视口外也不空窗，否则量不到高度）", () => {
        const [f, t] = windowRange(tops, heights, 0, 10, 0);
        expect(t).toBeGreaterThan(f);
    });
});

describe("HeightLedger：实测账", () => {
    it("未实测用兜底；实测后以实测为准，且返回高度增量", () => {
        const led = new HeightLedger();
        expect(led.get("a")).toBe(ROW_FALLBACK);
        const d = led.set("a", 1000);
        expect(d).toBe(1000 - ROW_FALLBACK); // 基准是写入前的估算
        expect(led.get("a")).toBe(1000);
        expect(led.set("a", 1000)).toBe(0); // 同值不产生增量
        expect(led.set("a", 1200)).toBe(200);
    });

    it("估算 = 已实测均值（会话越长越准）", () => {
        const led = new HeightLedger();
        led.set("a", 100);
        led.set("b", 300);
        expect(led.get("未测")).toBe(200);
    });

    it("retain 丢掉已不存在的行（均值不被旧轮拖着走）", () => {
        const led = new HeightLedger();
        led.set("a", 100);
        led.set("b", 300);
        led.retain(["b"]);
        expect(led.has("a")).toBe(false);
        expect(led.get("c")).toBe(300); // 只剩 b ⇒ 均值 300
    });
});

describe("bottomOf", () => {
    it("= top + height（不含行距）", () => {
        expect(bottomOf([0, 112], [100, 100], 1)).toBe(212);
    });
});
