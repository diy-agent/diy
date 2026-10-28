// tests/core/auto-compact.test.ts
// ##442 最大精简：配置只剩 policy + history.limit.summary.mode；触发线零旋钮。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_AUTO_COMPACT,
    detectAutoCompactTriggers,
    normalizeAutoCompact,
} from "@diy/compact/compact-config";

describe("配置归一", () => {
    it("缺省：policy 完整、summary=model", () => {
        const c = normalizeAutoCompact({});
        expect(c.policy.modeData.toolResult.render).toBe(DEFAULT_AUTO_COMPACT.policy.modeData.toolResult.render);
        expect(c.history?.limit?.summary.mode).toBe("model");
    });

    it("保留 summary.mode=self", () => {
        const c = normalizeAutoCompact({ history: { limit: { summary: { mode: "self" } } } });
        expect(c.history?.limit?.summary.mode).toBe("self");
    });

    it("旧 triggers / limitTokens / summary.enabled 被忽略并出声", () => {
        const issues: { path: string; message: string }[] = [];
        normalizeAutoCompact(
            {
                triggers: { windowOverRatio: 0.8 },
                history: { limit: { limitTokens: 30000, summary: { enabled: true } } },
                mode: "auto",
            },
            issues,
        );
        expect(issues.map((i) => i.path)).toEqual(
            expect.arrayContaining(["mode", "triggers", "history.limit.limitTokens", "history.limit.summary.enabled"]),
        );
    });
});

describe("触发线：W − max(10%W, 16k)，一个比较", () => {
    it("1M 窗口 899,999 不触发；900,000 触发", () => {
        const base = { windowLimitTokens: 1_000_000 };
        expect(detectAutoCompactTriggers({ ...base, windowTokens: 899_999 })).toEqual([]);
        expect(detectAutoCompactTriggers({ ...base, windowTokens: 900_000 })).toEqual(["contextWindowOver"]);
    });

    it("128k 窗口触发线 112k（16k 兜底）；256k 触发线 230.4k", () => {
        expect(
            detectAutoCompactTriggers({
                windowTokens: 112_000,
                windowLimitTokens: 128_000,
            }),
        ).toEqual(["contextWindowOver"]);
        expect(
            detectAutoCompactTriggers({
                windowTokens: 230_400,
                windowLimitTokens: 256_000,
            }),
        ).toEqual(["contextWindowOver"]);
    });

    it("窗口 / 用量未知 ⇒ 不触发（不猜数）", () => {
        expect(detectAutoCompactTriggers({ windowTokens: 999_999, windowLimitTokens: null })).toEqual([]);
        expect(detectAutoCompactTriggers({ windowTokens: null, windowLimitTokens: 1_000_000 })).toEqual([]);
    });
});
