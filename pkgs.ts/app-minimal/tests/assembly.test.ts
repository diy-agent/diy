import { describe, expect, it } from "vitest";
import { ASSEMBLY } from "../src/index.js";

describe("装配清单", () => {
    it("至少装了一个页面插件，且 id / name 都是非空字符串", () => {
        expect(ASSEMBLY.plugins.length).toBeGreaterThan(0);
        for (const plugin of ASSEMBLY.plugins) {
            expect(plugin.id.length).toBeGreaterThan(0);
            expect(plugin.name.length).toBeGreaterThan(0);
        }
    });
});
