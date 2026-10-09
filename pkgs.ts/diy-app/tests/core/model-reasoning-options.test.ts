// tests/core/model-reasoning-options.test.ts
// 🎯 models.dev `reasoning_options` → diy 档位表的映射（shared/model-config.reasoningFromSpec）。
//
// 锁的契约：
//   · 有 effort 词表 → 取**上游声明**的精确档位，并**恒以「平台默认」default 开头**
//   · 无 effort 词表（false / toggle / budget_tokens / 空 / 缺字段）→ **只有平台默认**（declared:false）
//     —— 上游没给可传递的 effort 词表时，不假装精确、也不强制「关闭」，交平台默认行为。
import { describe, it, expect } from "vitest";
import { reasoningFromSpec, DEFAULT_EFFORT } from "../../src/shared/model-config";

describe("reasoningFromSpec — models.dev reasoning_options 映射", () => {
    it("reasoning:false → 只有平台默认（不发送档位）", () => {
        expect(reasoningFromSpec(false, undefined)).toEqual({
            supported: [DEFAULT_EFFORT],
            default: DEFAULT_EFFORT,
            declared: false,
        });
    });

    it("effort 词表 → 精确档位（平台默认开头），default 优先 medium", () => {
        const r = reasoningFromSpec(true, [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }]);
        expect(r.supported).toEqual([DEFAULT_EFFORT, "none", "low", "medium", "high", "xhigh", "max"]);
        expect(r.default).toBe("medium");
        expect(r.declared).toBe(true);
    });

    it("无 medium 时 default 取 high，再退首项", () => {
        expect(reasoningFromSpec(true, [{ type: "effort", values: ["low", "high", "max"] }]).default).toBe("high");
        expect(reasoningFromSpec(true, [{ type: "effort", values: ["low", "max"] }]).default).toBe("low");
    });

    it("toggle / budget_tokens 不是 effort → 只有平台默认（declared:false）", () => {
        for (const opts of [
            [{ type: "toggle" }],
            [{ type: "budget_tokens", max: 262144 }],
            [],
            undefined,
        ]) {
            const r = reasoningFromSpec(true, opts as never);
            expect(r).toEqual({ supported: [DEFAULT_EFFORT], default: DEFAULT_EFFORT, declared: false });
        }
    });

    it("多面 provider（opencode-go 的 gpt-6-luna 等）模型级词表各不同", () => {
        const luna = reasoningFromSpec(true, [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }]);
        const mimo = reasoningFromSpec(true, []); // models.dev 里 mimo reasoning_options:[]
        expect(luna.supported).toContain("xhigh");
        expect(mimo.supported).toEqual([DEFAULT_EFFORT]);
        expect(mimo.declared).toBe(false);
    });
});
