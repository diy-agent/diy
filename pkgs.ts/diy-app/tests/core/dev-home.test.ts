// tests/core/dev-home.test.ts
// 🎯 dev 变体（preview/lab）数据根的决策：恒为 build/<variant>/home，继承来的**生产根**必须被拒。
// 这条守的是「别把示例数据写进用户真实数据根」（##286 实测：宿主 shell 的 DIY_HOME=~/.diy
// 一路透传，preview 直奔生产）。
//
// 「生产根」的定义在 instance-identity（单一定义处，见那里的单测）；本文件只测「撞上后怎么办」。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveDevHome } from "../../src/main/core/dev-home";
import { prodDataHome } from "../../src/main/core/instance-identity";

const REPO = "/repo";

describe("resolveDevHome", () => {
    it("没有继承值 → build/<variant>/home", () => {
        expect(resolveDevHome({ variant: "preview", repoRoot: REPO })).toEqual({
            home: join(REPO, "build/preview/home"),
            rejected: null,
        });
        expect(resolveDevHome({ variant: "lab", repoRoot: REPO }).home).toBe(
            join(REPO, "build/lab/home"),
        );
    });

    it("继承生产根 → 拒绝并回落到本变体的 home", () => {
        const d = resolveDevHome({
            variant: "preview",
            repoRoot: REPO,
            inherited: prodDataHome(),
        });
        expect(d.home).toBe(join(REPO, "build/preview/home"));
        expect(d.rejected).toBe(prodDataHome());
    });

    it("生产根的等价写法（尾斜杠）也拒绝", () => {
        const d = resolveDevHome({
            variant: "lab",
            repoRoot: REPO,
            inherited: `${prodDataHome()}/`,
        });
        expect(d.home).toBe(join(REPO, "build/lab/home"));
    });

    it("DIY_ALLOW_PROD_HOME 显式放行时照旧透传", () => {
        const d = resolveDevHome({
            variant: "preview",
            repoRoot: REPO,
            inherited: prodDataHome(),
            allowProdHome: true,
        });
        expect(d.home).toBe(prodDataHome());
        expect(d.rejected).toBeNull();
    });

    it("非生产的自定义 home 照旧透传（实验要用临时目录）", () => {
        const d = resolveDevHome({
            variant: "lab",
            repoRoot: REPO,
            inherited: "/tmp/scratch-home",
        });
        expect(d.home).toBe("/tmp/scratch-home");
        expect(d.rejected).toBeNull();
    });
});
