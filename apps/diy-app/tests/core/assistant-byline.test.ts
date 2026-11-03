// tests/core/assistant-byline.test.ts — 对话署名取哪份数据
//
// 需求（任务 196）：署名是**该轮事实**（turn.attrs.model，源自 ops 的 turn start meta）
// 的投影，不是当前人物配置的投影。改 personas.yaml 的缺省不得改写历史署名；
// 旧会话没有记录时回落当前人物但必须标注为**推断**。
import { describe, expect, it } from "vitest";
import { bylineOf } from "../../src/renderer_solid/lib/assistant-byline";

describe("对话署名", () => {
    it("该轮记录了 model：以该轮为准，不受当前人物影响", () => {
        const b = bylineOf({
            turnModel: "mimo-v2.6-flash",
            personaName: "大副",
            personaModel: "deepseek-v4.1-flash",
        });
        expect(b.model).toBe("mimo-v2.6-flash");
        expect(b.inferred).toBe(false);
        // 名字只在"当前人物模型 == 该轮模型"时才与事实自洽；否则宁可不写名字，
        // 也不能拿当前人物的名字去顶替（那正是原 bug：署名成了当前配置的投影）
        expect(b.name).toBeNull();
    });

    it("该轮 model 与当前人物一致：名字与模型都给，且不是推断", () => {
        const b = bylineOf({
            turnModel: "deepseek-v4.1-flash",
            personaName: "大副",
            personaModel: "deepseek-v4.1-flash",
        });
        expect(b.name).toBe("大副");
        expect(b.model).toBe("deepseek-v4.1-flash");
        expect(b.inferred).toBe(false);
    });

    it("旧会话无 model 记录：回落当前人物，但标注为推断", () => {
        const b = bylineOf({ personaName: "大副", personaModel: "deepseek-v4.1-flash" });
        expect(b.name).toBe("大副");
        expect(b.model).toBe("deepseek-v4.1-flash");
        expect(b.inferred).toBe(true);
        expect(b.title).toContain("推断");
    });

    it("旧会话且人物清单未到：不崩，只剩推断标注", () => {
        const b = bylineOf({});
        expect(b.name).toBeNull();
        expect(b.model).toBe("");
        expect(b.inferred).toBe(true);
    });

    it("model 是空串/非字符串（脏数据）：等同无记录，不当作事实", () => {
        for (const bad of ["", "   ", null, undefined, 42, {}]) {
            const b = bylineOf({ turnModel: bad, personaName: "大副", personaModel: "m" });
            expect(b.inferred).toBe(true);
            expect(b.model).toBe("m");
        }
    });
});
