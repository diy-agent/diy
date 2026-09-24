// tests/core/local-models-api.test.ts
// 🎯 模型清单的「API 面」契约：zen/go 的 /models 不返回面信息，只能逐个标注；
// 标错的表现是上游 503 Endpoint is unavailable（responses-only 模型打到 /chat/completions）。
// 见 projects/4/tasks/145：gpt-5.6-luna 选 chat 面必 503，切 responses 面即通。
import { describe, it, expect } from "vitest";
import { LOCAL_MODELS, apiOf } from "../../src/main/services/local-agent";

describe("LOCAL_MODELS 的 api 面标注", () => {
    it("每个模型都必须显式标注 api，且只能是 chat / responses", () => {
        for (const m of LOCAL_MODELS) {
            expect(["chat", "responses"]).toContain(m.api);
        }
        expect(LOCAL_MODELS.every((m) => typeof m.api === "string")).toBe(true);
    });

    it("responses-only 模型逐个点名（回归护栏：漏标 = 选中即 503）", () => {
        const responses = LOCAL_MODELS.filter((m) => m.api === "responses").map((m) => m.id);
        expect(responses).toEqual(["gpt-5.6-luna", "muse-spark-1.2-contributor", "muse-spark-1.3-contributor"]);
    });

    it("apiOf：已知模型按标注；未知模型回退 chat（不静默换面）", () => {
        expect(apiOf("gpt-5.6-luna")).toBe("responses");
        expect(apiOf("mimo-v2.5")).toBe("chat");
        expect(apiOf("不存在的模型")).toBe("chat");
    });

    it("id 唯一（重复 id 会让 apiOf/contextLimitOf 命中先到者）", () => {
        const ids = LOCAL_MODELS.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
