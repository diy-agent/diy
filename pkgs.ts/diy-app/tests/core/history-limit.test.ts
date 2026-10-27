// tests/core/history-limit.test.ts
// ##442 最大精简：配置面只剩 summary.mode / windowTokens；选段走 selectCompactableRange。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_HISTORY_LIMIT,
    estimateTokensOf,
    normalizeHistoryLimit,
    selectCompactableRange,
} from "../../src/shared/context/history-limit";

const msg = (tokens: number, user = false) => ({ role: user ? "user" : "assistant", content: "x".repeat(tokens * 4) });

/** 偶数下标是 user；每条 content 正好约 tokens */
function seq(n: number, tokens: number) {
    return Array.from({ length: n }, (_, i) => msg(tokens, i % 2 === 0));
}

describe("配置面：只剩 summary.mode（+ 窗口兜底）", () => {
    it("缺省 = model；旧 limitTokens / summary.enabled 被忽略", () => {
        expect(normalizeHistoryLimit(undefined)).toEqual(DEFAULT_HISTORY_LIMIT);
        const old = normalizeHistoryLimit({ limitTokens: 123, summary: { enabled: false } });
        expect(old.summary.mode).toBe("model");
    });

    it("self 被保留；windowTokens 是显式覆盖", () => {
        const h = normalizeHistoryLimit({ summary: { mode: "self" }, windowTokens: 20_000 });
        expect(h.summary.mode).toBe("self");
        expect(h.windowTokens).toBe(20_000);
    });
});

describe("selectCompactableRange：从尾装够 → user 切点", () => {
    it("窗口 20k：保留 3200、触发 4000；总量 4000 ⇒ 丢最老一段", () => {
        const r = selectCompactableRange(seq(10, 400), { windowTokens: 20_000 });
        expect(r).not.toBeNull();
        expect(r!.cut).toBeGreaterThan(0);
        expect(r!.retainedTokens).toBeGreaterThanOrEqual(3_200);
    });

    it("总量不到触发线 ⇒ 自动不压；force ⇒ 至少丢一步（切到第二条 user）", () => {
        const all = seq(6, 300); // 1800 < trigger 4000
        expect(selectCompactableRange(all, { windowTokens: 20_000 })).toBeNull();
        const forced = selectCompactableRange(all, { windowTokens: 20_000, force: true });
        expect(forced).not.toBeNull();
        expect(forced!.cut).toBe(2); // 第二条 user
    });

    it("已有边界：force 时新切点必须 > minCut（不能把历史放回来）", () => {
        const all = seq(10, 400);
        const r = selectCompactableRange(all, { windowTokens: 20_000, force: true, minCut: 2 });
        expect(r!.cut).toBeGreaterThan(2);
    });

    it("窗口未知 / 0 ⇒ 不压（不猜数）", () => {
        expect(selectCompactableRange(seq(10, 400), { windowTokens: 0 })).toBeNull();
    });
});

describe("token 粗估：中文不按 /4 低估", () => {
    it("CJK 1 token/字，其余 4 字符/1 token", () => {
        expect(estimateTokensOf("压缩")).toBe(2);
        expect(estimateTokensOf("abcdefgh")).toBe(2);
        expect(estimateTokensOf("压缩abcd")).toBe(3);
    });
});
