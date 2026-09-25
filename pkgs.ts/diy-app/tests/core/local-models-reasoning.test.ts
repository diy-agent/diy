// tests/core/local-models-reasoning.test.ts
// 🎯 推理强度清单的契约：supported 只能来自「上游实测的支持集」。
// 真源 = 上游自己的校验报错：发非法 reasoning_effort（chat 面）/ reasoning.effort（responses 面），
// 它回 400 并列出 expected one of ...，再逐值实测确认 200 / 400（见 local-agent.ts 的 LOCAL_MODELS 注释）。
// 见 projects/4/tasks/162：deepseek-v4.1-flash 曾写成 none/low/medium —— 既漏了真实档位，又把 medium 当可用。
import { describe, it, expect } from "vitest";
import { LOCAL_MODELS, reasoningOf } from "../../src/main/services/local-agent";
import { REASONING_EFFORT_LABELS } from "../../src/shared/reasoning-effort";

/** 档位全序（UI 直接按数组顺序渲染，低级 → 高级）；不在此表内的值一律视为未登记 */
const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"];

describe("LOCAL_MODELS 的 reasoning 档位", () => {
    it("supported 非空且无重复（空列表会让推理强度菜单只剩兜底项）", () => {
        for (const m of LOCAL_MODELS) {
            expect(m.reasoning.supported.length, m.id).toBeGreaterThan(0);
            expect(new Set(m.reasoning.supported).size, m.id).toBe(m.reasoning.supported.length);
        }
    });

    it("default 必须在 supported 里（否则切到该模型后选中的是不存在的档位）", () => {
        for (const m of LOCAL_MODELS) {
            expect(m.reasoning.supported, m.id).toContain(m.reasoning.default);
        }
    });

    it("supported 按档位全序排列（乱序会看起来缺档）", () => {
        for (const m of LOCAL_MODELS) {
            const idx = m.reasoning.supported.map((v) => ORDER.indexOf(v));
            expect(idx, `${m.id}: ${m.reasoning.supported.join(",")}`).not.toContain(-1);
            expect(idx, m.id).toEqual([...idx].sort((a, b) => a - b));
        }
    });

    it("档位值都在显示词表内（缺词会退化成英文原词）", () => {
        for (const m of LOCAL_MODELS) {
            for (const v of m.reasoning.supported) {
                expect(Object.keys(REASONING_EFFORT_LABELS), `${m.id}/${v}`).toContain(v);
            }
        }
    });

    it("显示词表不含无模型支持的值（否则会出现选了必 400 的档位）", () => {
        const used = new Set(LOCAL_MODELS.flatMap((m) => m.reasoning.supported));
        for (const label of Object.keys(REASONING_EFFORT_LABELS)) {
            expect(used, label).toContain(label);
        }
    });

    it("回归护栏：逐个模型的实测支持集（2026-09-24 探测）", () => {
        const expected: Record<string, string[]> = {
            // 两个 luna：无 minimal（上游明示 Unsupported value）
            "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
            "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
            // 唯一带 ultra 的模型（非 pi 标准档，但上游实测 200）
            "deepseek-v4.1-flash": ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"],
            // 只认四档：minimal/xhigh/max 一律 400 Invalid request parameters
            "mimo-v2.6-flash": ["none", "low", "medium", "high"],
        };
        for (const [id, supported] of Object.entries(expected)) {
            expect(reasoningOf(id).supported, id).toEqual(supported);
        }
    });

    it("reasoningOf：未知模型回退成「只能关闭」", () => {
        expect(reasoningOf("不存在的模型")).toEqual({ supported: ["none"], default: "none" });
    });
});
