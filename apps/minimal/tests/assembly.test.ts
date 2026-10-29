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
});
