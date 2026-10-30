import { describe, expect, it } from "vitest";
import { ASSEMBLY } from "../index.js";

describe("apps/chat 装配清单", () => {
    it("装的是 chat-page + model-config-page 插件（type: module，真模块）", () => {
        expect(ASSEMBLY.plugins.map((entry) => entry.id)).toEqual(["chat-page", "model-config-page"]);
        for (const entry of ASSEMBLY.plugins) {
            expect(entry.type).toBe("module");
            expect(typeof (entry.data as { module: { default?: unknown } }).module.default).toBe("function");
        }
    });

    it("model-config 页的装配配置带数据根（DIY_HOME 存在时）", () => {
        const config = (ASSEMBLY.plugins[1] as { config?: { home?: string } }).config;
        if (process.env["DIY_HOME"] === undefined) {
            expect(config?.home).toBeUndefined();
            return;
        }
        expect(config?.home).toBe(process.env["DIY_HOME"]);
    });

    it("DIY_HOME 存在 ⇒ 注入多会话宿主；缺席 ⇒ 不注入（退回插件单会话形态）", () => {
        const sessions = (ASSEMBLY.plugins[0] as { config?: { sessions?: Record<string, unknown> } }).config
            ?.sessions;
        if (process.env["DIY_HOME"] === undefined) {
            expect(sessions).toBeUndefined();
            return;
        }
        expect(typeof sessions?.["snapshot"]).toBe("function");
        expect(typeof sessions?.["send"]).toBe("function");
    });
});
