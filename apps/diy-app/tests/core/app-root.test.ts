// 包根定位：源码模式与产物模式深度不同（这正是旧实现「数 dirname」失守的地方）。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveAppRoot } from "../../src/main/core/app-root";

/** 只有这些路径算存在；其余一律不存在 —— 让上溯的每一步都可控 */
const only = (...present: string[]) => {
    const set = new Set(present.map((p) => p));
    return (p: string) => set.has(p);
};

// ⚠️ 假路径必须用 `join` 拼：实现走的是 `path.join/dirname`，Windows 下 join 产出 `\`，
// 写死 `/repo/...` 会让"存在性注入"里 set.has() 永远不等（实测 5 条用例全红）。
// 根取一个平台锚点，其余全部 join 下去。
const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";
const APP = join(ROOT, "apps", "diy-app");
const PKG = join(ROOT, "usr", "lib", "node_modules", "diy-app");

describe("resolveAppRoot", () => {
    it("源码模式：src/cli/index.ts → 包根（固定 4 次 dirname 会算到 pkgs.ts/）", () => {
        expect(resolveAppRoot(join(APP, "src", "cli", "index.ts"), only(join(APP, "package.json")))).toBe(APP);
    });

    it("产物模式：build/<variant>/cli/index.js → 包根", () => {
        for (const v of ["prod", "test", "lab"]) {
            expect(resolveAppRoot(join(APP, "build", v, "cli", "index.js"), only(join(APP, "package.json")))).toBe(APP);
        }
    });

    it("npm 打包安装：包内只有 bin/ 与 build/prod/，package.json 仍在上溯路径上", () => {
        expect(resolveAppRoot(join(PKG, "build", "prod", "cli", "index.js"), only(join(PKG, "package.json")))).toBe(
            PKG,
        );
    });

    it("从模块目录内任意深度出发都收敛到包根（src/main/core/xxx.ts 同样适用）", () => {
        expect(resolveAppRoot(join(APP, "src", "main", "core", "app-root.ts"), only(join(APP, "package.json")))).toBe(
            APP,
        );
    });

    it("找不到包标记 → 抛错（不静默给出错路径）", () => {
        expect(() => resolveAppRoot(join(APP, "src", "cli", "index.ts"), () => false)).toThrow(/找不到包根/);
    });

    it("不越过就近的那个标记（子包里出现 package.json 时以近者为准）", () => {
        const sub = join(APP, "node_modules", "some-pkg");
        expect(
            resolveAppRoot(join(sub, "dist", "index.js"), only(join(sub, "package.json"), join(APP, "package.json"))),
        ).toBe(sub);
    });
});
