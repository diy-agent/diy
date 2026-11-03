// tests/os/selection.test.ts
// 🎯 策略选型：`DIY_OS_STRATEGY` 只是**环境覆盖**（CI 冒烟 / 排障），不是用户可配置项。
// 非法值必须 warn 后回落平台事实 —— 模块顶层抛错会连报错 UI 都起不来。

import { describe, expect, it } from "vitest";
import { osKindOf } from "../../src/main/os/index";

describe("osKindOf", () => {
    it("合法值覆盖平台事实", () => {
        expect(osKindOf("posix", "win32")).toBe("posix");
        expect(osKindOf("win32", "linux")).toBe("win32");
    });

    it("未设置 ⇒ 按平台", () => {
        expect(osKindOf(undefined, "win32")).toBe("win32");
        expect(osKindOf(undefined, "linux")).toBe("posix");
        expect(osKindOf(undefined, "darwin")).toBe("posix");
    });

    it("非法值 ⇒ 回落平台（不抛）", () => {
        expect(() => osKindOf("windows", "darwin")).not.toThrow();
        expect(osKindOf("windows", "darwin")).toBe("posix");
        expect(osKindOf("", "win32")).toBe("win32");
    });
});
