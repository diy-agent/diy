// tests/core/history-limit.test.ts
// ##442 最大精简：配置面只剩 summary.mode / windowTokens；选段走 selectCompactableRange。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_HISTORY_LIMIT,
    estimateTokensOf,
    normalizeHistoryLimit,
    selectCompactableRange,
} from "@diy-agent/compaction/history-limit";

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

describe("手动 force：下一刀必须落新轮轮首", () => {
    it("turn a: 0-3；turn b: 4-9；force 从 0 起切到 4（不是轮中插话 6）", () => {
        const all = Array.from({ length: 10 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: "x",
            turn: i < 4 ? "a" : "b",
        }));
        const r = selectCompactableRange(all, { windowTokens: 100_000, force: true });
        expect(r).not.toBeNull();
        expect(r!.cut).toBe(4);
    });
});

describe("token 粗估：中文不按 /4 低估", () => {
    it("CJK 1 token/字，其余 4 字符/1 token", () => {
        expect(estimateTokensOf("压缩")).toBe(2);
        expect(estimateTokensOf("abcdefgh")).toBe(2);
        expect(estimateTokensOf("压缩abcd")).toBe(3);
    });
});

// ─── ##519：保留量覆盖（手动拖压缩位置用） ─────────────────────────
describe("retainTokens 覆盖：人给的预算说了算", () => {
    it("同一份历史：给更大预算 ⇒ 丢得更少（切点更靠前）", () => {
        const all = seq(20, 500); // 10 轮、约 10k
        // 两者都必须 < 触发线（20k 窗口的触发线 = 20k − 16k = 4k），否则会命中「压完仍超 ⇒ 不压」
        const tight = selectCompactableRange(all, { windowTokens: 20_000, retainTokens: 800 });
        const loose = selectCompactableRange(all, { windowTokens: 20_000, retainTokens: 2_400 });
        expect(tight).not.toBeNull();
        expect(loose).not.toBeNull();
        // 预算越大，保留越多 ⇒ cut 越小
        expect(loose!.cut).toBeLessThan(tight!.cut);
    });

    it("覆盖值不被窗口 × 0.16 盖回去（1M 窗口给 2000 预算也照办）", () => {
        const all = seq(20, 500);
        const r = selectCompactableRange(all, { windowTokens: 1_000_000, retainTokens: 2_000 });
        // 缺省 16% = 160k 会让它「一条都不丢」；覆盖后确实丢了
        expect(r).not.toBeNull();
        expect(r!.cut).toBeGreaterThan(0);
    });

    it("force + 覆盖：仍落在 user 上，且不为 0（至少丢一条）", () => {
        const all = seq(10, 500);
        const r = selectCompactableRange(all, { windowTokens: 1_000_000, retainTokens: 100_000, force: true });
        expect(r).not.toBeNull();
        expect(r!.cut).toBeGreaterThan(0);
        expect(all[r!.cut]!.role).toBe("user");
    });
});
