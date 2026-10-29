import { describe, expect, it } from "vitest";
import { ASSEMBLY } from "../index.js";

describe("装配清单", () => {
    it("至少装了一个页面插件，且每个单元的 type 是已知取法", () => {
        expect(ASSEMBLY.plugins.length).toBeGreaterThan(0);
        for (const plugin of ASSEMBLY.plugins) {
            expect(plugin.id.length).toBeGreaterThan(0);
            // ##458：插件引用是**直接 import 的模块本体**（type: "module"），不再是字符串包名
            expect(["module", "load"]).toContain(plugin.type);
        }
    });

    it("chat-page 插件带的是真模块（有 default 导出）", () => {
        const entry = ASSEMBLY.plugins.find((plugin) => plugin.id === "chat-page");
        expect(entry).toBeTruthy();
        expect(entry!.type).toBe("module");
        expect(typeof (entry!.data as { module: { default?: unknown } }).module.default).toBe("function");
    });

    it("没有 LLM_* 环境变量时不注入 provider（退回假回复，##457 行为不变）", () => {
        // 测试环境不带 LLM_BASE_URL / LLM_API_KEY；注入与否只看那一对变量
        expect(process.env["LLM_BASE_URL"]).toBeUndefined();
        const entry = ASSEMBLY.plugins.find((plugin) => plugin.id === "chat-page");
        const config = (entry as { config?: { llm?: unknown } }).config;
        expect(config?.llm).toBeUndefined();
    });
});
