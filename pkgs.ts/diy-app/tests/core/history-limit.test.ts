import { describe, expect, it } from "vitest";
import {
    DEFAULT_HISTORY_LIMIT,
    RETAIN_RATIO,
    estimateTokensOf,
    isCompleteHistoryLimit,
    normalizeHistoryLimit,
    selectCompactableRange,
} from "../../src/shared/context/history-limit";

/** 一条 core 形状的消息（适配层只看 role 与 content） */
const msg = (role: string, tokens: number, tag = "") => ({ role, content: `${tag}${"x".repeat(tokens * 4)}` });

describe("history-limit · 配置面（##442：只有 retainRatio + summary.mode）", () => {
    it("缺省 = 0.16（dsh 同值）+ 摘要 model", () => {
        expect(DEFAULT_HISTORY_LIMIT.retainRatio).toBe(RETAIN_RATIO);
        expect(DEFAULT_HISTORY_LIMIT.summary.mode).toBe("model");
    });

    it("retainRatio 夹到 (0.01, 0.5]：0 / 负数 / > 1 都不炸", () => {
        expect(normalizeHistoryLimit({ retainRatio: 0 }).retainRatio).toBe(RETAIN_RATIO);
        expect(normalizeHistoryLimit({ retainRatio: -1 }).retainRatio).toBe(RETAIN_RATIO);
        expect(normalizeHistoryLimit({ retainRatio: 0.9 }).retainRatio).toBe(0.5);
        expect(normalizeHistoryLimit({ retainRatio: 0.001 }).retainRatio).toBe(0.01);
        expect(normalizeHistoryLimit({ retainRatio: 0.25 }).retainRatio).toBe(0.25);
    });

    it("summary.mode 只有 model / self 两档；旧 enabled 布尔被忽略并回落 model", () => {
        expect(normalizeHistoryLimit({ summary: { mode: "self" } }).summary.mode).toBe("self");
        expect(normalizeHistoryLimit({ summary: { enabled: false } }).summary.mode).toBe("model");
        expect(normalizeHistoryLimit({}).summary.mode).toBe("model");
    });

    it("旧键 limitTokens 不再影响任何结果（保留量是窗口比例，没有可折算的等价物）", () => {
        const h = normalizeHistoryLimit({ limitTokens: 8_000 });
        expect(h.retainRatio).toBe(RETAIN_RATIO);
    });

    it("isCompleteHistoryLimit：只有两项都合法才算完整（用来出声）", () => {
        expect(isCompleteHistoryLimit({ retainRatio: 0.16, summary: { mode: "model" } })).toBe(true);
        expect(isCompleteHistoryLimit({ retainRatio: 0.16, summary: { enabled: true } })).toBe(false);
        expect(isCompleteHistoryLimit({ limitTokens: 30_000 })).toBe(false);
    });
});

describe("history-limit · estimateTokensOf（CJK 不能低估 4 倍）", () => {
    it("中文 1 token / 字，英文 4 字符 / 1 token", () => {
        expect(estimateTokensOf("压缩")).toBe(2);
        expect(estimateTokensOf("abcd")).toBe(1);
        expect(estimateTokensOf("压缩abcd")).toBe(3);
    });
});

describe("history-limit · selectCompactableRange（core 适配层）", () => {
    it("切点落在 user 消息上，返回 {cut, dropped}", () => {
        // 20 条交替；每条 100 token 级
        const all = Array.from({ length: 20 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", 100, `#${i}`));
        const r = selectCompactableRange(all, 500, 5_000);
        expect(r).not.toBeNull();
        expect(all[r!.cut]!.role).toBe("user");
        expect(r!.dropped).toBe(r!.cut);
    });

    it("窗口/触发线自相矛盾（触发线 ≤ 保留量）⇒ 不压", () => {
        const all = [msg("user", 100), msg("assistant", 100), msg("user", 100)];
        expect(selectCompactableRange(all, 500, 400)).toBeNull();
    });

    it("无 user 边界 / 无可丢 ⇒ null", () => {
        expect(selectCompactableRange([msg("assistant", 100), msg("assistant", 100)], 10, 1_000)).toBeNull();
        expect(selectCompactableRange([], 10, 1_000)).toBeNull();
    });
});
