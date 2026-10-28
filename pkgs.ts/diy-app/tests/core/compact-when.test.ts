// tests/core/compact-when.test.ts
// ##442 最大精简：「什么时候会压」= 一条触发线 + 手动。
import { describe, expect, it } from "vitest";
import {
    autoCompactSentence,
    compactResultSentence,
    compactWhenRows,
    compactWhenSummary,
    fmtStamp,
    fmtTokens,
    windowRatio,
    type CompactWhenInput,
} from "@diy/compact/compact-when";

const base: CompactWhenInput = {
    limitTokens: 32_000, // 200k × 0.16
    boundary: { at: "2026-10-25T10:00:00.000Z", dropped: 12, limitTokens: 32_000 },
    retainedTokens: 20_000,
    lastStepTokens: 50_000,
    windowLimit: 200_000,
};

const rowOf = (i: CompactWhenInput, key: string) => compactWhenRows(i).find((r) => r.key === key)!;

describe("compact-when · 判据", () => {
    it("四行齐全；自动触发线 = 窗口 − max(10%, 16k)", () => {
        expect(compactWhenRows(base).map((r) => r.key)).toEqual(["first", "retained", "reuse", "manual"]);
        // 200k − 20k = 180k（从没压过时直接说触发线）
        expect(rowOf({ ...base, boundary: null }, "first").text).toContain("180,000 tok");
    });

    it("窗口未知 ⇒ 不自动压（可手动）", () => {
        const i = { ...base, windowLimit: null };
        expect(rowOf(i, "first").state).toBe("off");
        expect(rowOf(i, "first").text).toContain("窗口未知");
        expect(rowOf(i, "manual").state).toBe("manual");
    });

    it("已有边界：保留段小于触发线 ⇒ 说明还差多少", () => {
        const r = rowOf(base, "retained");
        expect(r.state).toBe("on");
        expect(r.text).toContain("保留段 20,000 tok");
        expect(r.text).toContain("再涨 160,000 tok");
    });

    it("保留段顶到触发线 ⇒ 下一步再压", () => {
        const r = rowOf({ ...base, retainedTokens: 190_000 }, "retained");
        expect(r.text).toContain("下一步再压一次");
    });

    it("保留段没有实测 ⇒ 如实说", () => {
        expect(rowOf({ ...base, retainedTokens: null }, "retained").text).toContain("还没有实测");
    });

    it("每步投递：按已落盘边界切、不重算", () => {
        const r = rowOf(base, "reuse");
        expect(r.text).toContain("已落盘边界");
        expect(r.text).toContain("不重算");
    });

    it("手动：无视触发线，至少丢一步", () => {
        expect(rowOf(base, "manual").text).toContain("至少丢一步");
    });
});

describe("compact-when · 文案", () => {
    it("自动压缩只讲窗口触发，不再讲三触发器", () => {
        const s = autoCompactSentence();
        expect(s).toContain("窗口");
        expect(s).toContain("不改投递切点");
        expect(s).not.toContain("缓存过期");
        expect(s).not.toContain("系统上下文");
    });

    it("压成什么样：保留量 + 从尾累加 + user 切点 + 无保头/无配平", () => {
        const s = compactResultSentence(32_000);
        expect(s).toContain("32,000 tok");
        expect(s).toContain("从最后一条往前累加");
        expect(s).toContain("user 消息");
        expect(s).toContain("没有保头");
        expect(s).toContain("只在压缩事件时算一次");
    });

    it("人读小件", () => {
        expect(fmtTokens(20_000)).toBe("20,000 tok");
        expect(windowRatio(50_000, 200_000)).toBe(25);
        expect(windowRatio(null, 200_000)).toBeNull();
        expect(fmtStamp("2026-10-25T10:30:00.000Z")).toMatch(/^10-2\d* \d\d:\d\d$/);
        expect(compactWhenSummary(base)).toContain("已压过");
        expect(compactWhenSummary({ ...base, boundary: null })).toContain("还没压过");
    });
});
