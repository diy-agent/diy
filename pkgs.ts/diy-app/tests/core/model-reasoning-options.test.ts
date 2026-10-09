// tests/core/model-reasoning-options.test.ts
// 🎯 models.dev `reasoning_options` → diy 档位表的映射（shared/model-config.reasoningFromSpec）。
//
// 锁的契约：
//   · 有 effort 词表 → 取**上游声明**的精确档位，并**恒以「平台默认」default 开头**
//   · reasoning:true 但未登记任何 reasoning_options（空/缺字段）→ **通用兜底档位**（declared:false）
//   · reasoning:true 且明示非 effort（toggle / budget_tokens）→ **只有平台默认**（declared:false）
//   · false / reasoning 缺失 → **只有平台默认**（不发送档位，交上游默认行为）
import { describe, it, expect } from "vitest";
import {
    reasoningFromSpec,
    DEFAULT_EFFORT,
    GENERIC_REASONING_EFFORTS,
    GENERIC_REASONING_DEFAULT,
} from "../../src/shared/model-config";

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

    it("明示 toggle / budget_tokens（非 effort）→ 只有平台默认（declared:false）", () => {
        for (const opts of [
            [{ type: "toggle" }],
            [{ type: "budget_tokens", max: 262144 }],
            [{ type: "toggle" }, { type: "budget_tokens", max: 262144 }],
        ]) {
            const r = reasoningFromSpec(true, opts as never);
            expect(r).toEqual({ supported: [DEFAULT_EFFORT], default: DEFAULT_EFFORT, declared: false });
        }
    });

    it("reasoning:true 但未登记任何 reasoning_options → 通用兜底档位（declared:false）", () => {
        for (const opts of [[], undefined]) {
            const r = reasoningFromSpec(true, opts as never);
            expect(r.supported).toEqual([DEFAULT_EFFORT, ...GENERIC_REASONING_EFFORTS]);
            expect(r.default).toBe(GENERIC_REASONING_DEFAULT);
            expect(r.declared).toBe(false);
        }
    });

    it("reasoning 字段缺失（custom provider 无推理信息）且无词表 → 只有平台默认", () => {
        for (const opts of [[], undefined]) {
            expect(reasoningFromSpec(undefined, opts as never)).toEqual({
                supported: [DEFAULT_EFFORT],
                default: DEFAULT_EFFORT,
                declared: false,
            });
        }
    });

    it("多面 provider（opencode-go 的 gpt-6-luna 等）模型级词表各不同", () => {
        const luna = reasoningFromSpec(true, [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }]);
        const mimo = reasoningFromSpec(true, []); // models.dev 里 mimo reasoning_options:[]
        expect(luna.supported).toContain("xhigh");
        // mimo 未登记枚举 → 通用兜底（含 none/low/medium/high，与 diy 实测一致）
        expect(mimo.supported).toEqual([DEFAULT_EFFORT, "none", "low", "medium", "high"]);
        expect(mimo.supported).toContain("low"); // 存量 personas 的 effort=low 仍可选
        expect(mimo.supported).toContain("high");
        expect(mimo.declared).toBe(false);
    });
});
