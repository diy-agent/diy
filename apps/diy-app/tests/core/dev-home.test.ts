// tests/core/dev-home.test.ts
// 🎯 数据根决策：**只认显式值**。缺了报错（不按变体推导），继承来的生产根必须被拒。
// 这条守的是两件事：别把数据写进产物树（clean 会删），别把示例数据写进用户真实数据根。
//
// 「生产根」的定义在 instance-identity（单一定义处，见那里的单测）。

import { describe, it, expect } from "vitest";
import { resolveDataHome } from "../../src/main/core/dev-home";
import { prodDataHome } from "../../src/main/core/instance-identity";

describe("resolveDataHome", () => {
    it("没给显式值 → 报错（不推导 build/<variant>/home）", () => {
        expect(() => resolveDataHome({})).toThrow(/必须显式给数据根/);
    });

    it("空白值等同于没给", () => {
        expect(() => resolveDataHome({ explicit: "   " })).toThrow(/必须显式给数据根/);
    });

    it("报错带上入口脚本给的提示命令", () => {
        expect(() => resolveDataHome({ hint: "./diy.sh lab" })).toThrow(/\.\/diy\.sh lab/);
    });

    it("继承生产根 → 拒绝（报错，不静默回落）", () => {
        expect(() => resolveDataHome({ explicit: prodDataHome() })).toThrow(/拒绝用生产数据根/);
    });

    it("生产根的等价写法（尾斜杠）也拒绝", () => {
        expect(() => resolveDataHome({ explicit: `${prodDataHome()}/` })).toThrow(/拒绝用生产数据根/);
    });

    it("DIY_ALLOW_PROD_HOME 显式放行时照旧透传", () => {
        expect(resolveDataHome({ explicit: prodDataHome(), allowProdHome: true })).toEqual({
            home: prodDataHome(),
        });
    });

    it("自定义 home 照旧透传（实验要用临时目录）", () => {
        expect(resolveDataHome({ explicit: "/tmp/scratch-home" })).toEqual({
            home: "/tmp/scratch-home",
        });
    });
});
