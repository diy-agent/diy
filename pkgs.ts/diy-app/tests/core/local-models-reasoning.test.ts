// tests/core/local-models-reasoning.test.ts
// 🎯 推理强度契约：supported 非空无重复、default ∈ supported、按档位全序、词表内。
// 数据来源 = 目录（生产来自 snapshot ⊕ override；单测来自 fixtures/models.ts）。
import { describe, it, expect } from "vitest";
import { reasoningOf } from "../../src/main/services/local-agent";
import { REASONING_EFFORT_LABELS } from "../../src/shared/reasoning-effort";
import { OPENCODE_GO_SNAPSHOT } from "../fixtures/models";

/** 档位全序（UI 直接按数组顺序渲染，低级 → 高级） */
const ORDER = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"];

describe("目录模型的 reasoning 档位", () => {
    it("supported 非空且无重复", () => {
        for (const m of OPENCODE_GO_SNAPSHOT) {
            expect(m.reasoning.supported.length, m.id).toBeGreaterThan(0);
            expect(new Set(m.reasoning.supported).size, m.id).toBe(m.reasoning.supported.length);
        }
    });

    it("default 必须在 supported 里", () => {
        for (const m of OPENCODE_GO_SNAPSHOT) {
            expect(m.reasoning.supported, m.id).toContain(m.reasoning.default);
        }
    });

    it("supported 按档位全序排列", () => {
        for (const m of OPENCODE_GO_SNAPSHOT) {
            const idx = m.reasoning.supported.map((v) => ORDER.indexOf(v));
            expect(idx, m.id).not.toContain(-1);
            expect(idx, m.id).toEqual([...idx].sort((a, b) => a - b));
        }
    });

    it("档位值都在显示词表内", () => {
        for (const m of OPENCODE_GO_SNAPSHOT) {
            for (const v of m.reasoning.supported) {
                expect(Object.keys(REASONING_EFFORT_LABELS), `${m.id}/${v}`).toContain(v);
            }
        }
    });

    it("回归护栏：逐个模型的支持集（fixture）", () => {
        const expected: Record<string, string[]> = {
            "gpt-5.6-luna": ["default", "none", "low", "medium", "high", "xhigh", "max"],
            "gpt-6-luna": ["default", "none", "low", "medium", "high", "xhigh", "max"],
            "deepseek-v4.1-flash": ["default", "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"],
            "mimo-v2.6-flash": ["default", "none", "low", "medium", "high"],
        };
        for (const [id, supported] of Object.entries(expected)) {
            expect(reasoningOf(id).supported, id).toEqual(supported);
        }
    });

    it("reasoningOf：未知模型回退成「平台默认」", () => {
        expect(reasoningOf("不存在的模型")).toEqual({ supported: ["default"], default: "default" });
    });
});
