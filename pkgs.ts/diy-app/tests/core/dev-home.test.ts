// tests/core/dev-home.test.ts
// 🎯 dev 变体（preview/lab）数据根的决策：恒为 build/<variant>/home，继承来的**生产根**必须被拒。
// 这条守的是「别把示例数据写进用户真实数据根」（##286 实测：宿主 shell 的 DIY_HOME=~/.diy
// 一路透传，preview 直奔生产）。

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProdHome, resolveDevHome } from "../../src/main/core/dev-home";

const HOME = "/home/tester";
const REPO = "/repo";

describe("isProdHome", () => {
    it("$HOME/.diy 才算生产根", () => {
        expect(isProdHome("/home/tester/.diy", HOME)).toBe(true);
        expect(isProdHome("/home/tester/.diy/", HOME)).toBe(true); // 尾斜杠不该绕过
        expect(isProdHome("/home/tester/.diy/dev", HOME)).toBe(false); // 子目录不是根
        expect(isProdHome("/home/tester/.diy-x", HOME)).toBe(false);
        expect(isProdHome(join(homedir(), ".diy"))).toBe(true); // 缺省用真实家目录
    });
});

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
            inherited: join(HOME, ".diy"),
            homeDir: HOME,
        });
        expect(d.home).toBe(join(REPO, "build/preview/home"));
        expect(d.rejected).toBe(join(HOME, ".diy"));
    });

    it("DIY_ALLOW_PROD_HOME 显式放行时照旧透传", () => {
        const d = resolveDevHome({
            variant: "preview",
            repoRoot: REPO,
            inherited: join(HOME, ".diy"),
            homeDir: HOME,
            allowProdHome: true,
        });
        expect(d.home).toBe(join(HOME, ".diy"));
        expect(d.rejected).toBeNull();
    });

    it("非生产的自定义 home 照旧透传（实验要用临时目录）", () => {
        const d = resolveDevHome({
            variant: "lab",
            repoRoot: REPO,
            inherited: "/tmp/scratch-home",
            homeDir: HOME,
        });
        expect(d.home).toBe("/tmp/scratch-home");
        expect(d.rejected).toBeNull();
    });
});
