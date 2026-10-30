import { describe, expect, it } from "vitest";
import { ASSEMBLY } from "../index.js";

describe("apps/chat 装配清单", () => {
    it("装的是 chat-page 插件（type: module，真模块）", () => {
        expect(ASSEMBLY.plugins).toHaveLength(1);
        const entry = ASSEMBLY.plugins[0]!;
        expect(entry.id).toBe("chat-page");
        expect(entry.type).toBe("module");
        expect(typeof (entry.data as { module: { default?: unknown } }).module.default).toBe("function");
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
