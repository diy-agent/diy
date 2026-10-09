// tests/core/model-reasoning-options.test.ts
// 🎯 models.dev `reasoning_options` → diy 档位表的映射（shared/model-config.reasoningFromSpec）。
//
// 锁的契约：档位词表**优先取上游声明**（effort values），不再一律套通用集；
// 上游未声明（空/toggle/budget）才退回兜底集，且 marked declared=false（UI 要标注"未声明"）。
import { describe, it, expect } from "vitest";
import { reasoningFromSpec, STD_REASONING_FALLBACK } from "../../src/shared/model-config";

describe("reasoningFromSpec — models.dev reasoning_options 映射", () => {
    it("reasoning:false → 只能关闭（declared）", () => {
        expect(reasoningFromSpec(false, undefined)).toEqual({ supported: ["none"], default: "none", declared: true });
    });

    it("effort 词表 → 精确档位，default 优先 medium", () => {
        const r = reasoningFromSpec(true, [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }]);
        expect(r.supported).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
        expect(r.default).toBe("medium");
        expect(r.declared).toBe(true);
    });

    it("无 medium 时 default 取 high，再退首项", () => {
        expect(reasoningFromSpec(true, [{ type: "effort", values: ["low", "high", "max"] }]).default).toBe("high");
        expect(reasoningFromSpec(true, [{ type: "effort", values: ["low", "max"] }]).default).toBe("low");
    });

    it("toggle / budget_tokens 不是 effort → 退回兜底集（declared:false）", () => {
        for (const opts of [
            [{ type: "toggle" }],
            [{ type: "budget_tokens", max: 262144 }],
            [],
            undefined,
        ]) {
            const r = reasoningFromSpec(true, opts as never);
            expect(r).toEqual({ ...STD_REASONING_FALLBACK, declared: false });
        }
    });

    it("多面 provider（opencode-go 的 gpt-6-luna 等）模型级词表各不同", () => {
        const luna = reasoningFromSpec(true, [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }]);
        const mimo = reasoningFromSpec(true, []); // models.dev 里 mimo reasoning_options:[]
        expect(luna.supported).toContain("xhigh");
        expect(mimo.supported).not.toContain("xhigh"); // 兜底集只到 high
        expect(mimo.declared).toBe(false);
    });
});
