// tests/core/local-models-api.test.ts
// 🎯 模型清单的「API 面」契约：zen/go 的 /models 不返回面信息，只能逐个标注；
// 标错的表现是上游 503 Endpoint is unavailable（responses-only 模型打到 /chat/completions）。
// 见 projects/4/tasks/145：gpt-5.6-luna 选 chat 面必 503，切 responses 面即通；
// 见 projects/4/tasks/162：同一现象在 gpt-6-luna 上复现，两者都是 responses-only。
import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL, LOCAL_MODELS, apiOf } from "../../src/main/services/local-agent";

describe("LOCAL_MODELS 的 api 面标注", () => {
    it("每个模型都必须显式标注 api，且只能是 chat / responses", () => {
        for (const m of LOCAL_MODELS) {
            expect(["chat", "responses"]).toContain(m.api);
        }
        expect(LOCAL_MODELS.every((m) => typeof m.api === "string")).toBe(true);
    });

    it("responses-only 模型逐个点名（回归护栏：漏标 = 选中即 503）", () => {
        const responses = LOCAL_MODELS.filter((m) => m.api === "responses").map((m) => m.id);
        expect(responses).toEqual(["gpt-5.6-luna", "gpt-6-luna"]);
    });

    it("apiOf：已知模型按标注；未知模型回退 chat（不静默换面）", () => {
        expect(apiOf("gpt-5.6-luna")).toBe("responses");
        expect(apiOf("mimo-v2.6-flash")).toBe("chat");
        expect(apiOf("不存在的模型")).toBe("chat");
    });

    it("DEFAULT_MODEL 在清单内（清单顺序 = 展示顺序，与「默认用哪个」不是同一件事）", () => {
        // 这里曾经锁的是「首项 === DEFAULT_MODEL」。清单顺序改成"按价格从低到高"（便宜的先看见）后，
        // 首项成了**展示顺序**的产物，而"默认用哪个模型"是内置 persona 的 model —— 两件事分开。
        // 真正要防的是 DEFAULT_MODEL 写出清单外的 id（apiOf/reasoningOf 会 fallback 成"未知模型只能关闭"）。
        expect(DEFAULT_MODEL).toBe("gpt-5.6-luna");
        expect(LOCAL_MODELS.map((m) => m.id)).toContain(DEFAULT_MODEL);
    });

    it("清单顺序 = 展示顺序：便宜的先看见（mimo → deepseek → gpt-5.6 → gpt-6）", () => {
        // UI 的模型平铺按钮按清单顺序渲染，顺序即"从便宜到贵"，这条防止有人无意间把它排回去。
        expect(LOCAL_MODELS.map((m) => m.id)).toEqual([
            "mimo-v2.6-flash",
            "deepseek-v4.1-flash",
            "gpt-5.6-luna",
            "gpt-6-luna",
        ]);
    });

    it("id 唯一（重复 id 会让 apiOf/contextLimitOf 命中先到者）", () => {
        const ids = LOCAL_MODELS.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
