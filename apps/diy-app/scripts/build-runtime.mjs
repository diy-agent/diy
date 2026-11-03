#!/usr/bin/env node
// scripts/build-runtime.mjs — 生成 `runtime/`：Electron 打包后可被 Node 解析的 `@diy-agent/*` npm 结构。
//
// 为什么需要（##455，设计见 diy-research/.../07-electron-plugin-strategy.md 五、九节）：
//   打包后 `files:` 明确排除了 `node_modules/**`，安装形态里没有 npm 包结构；
//   主进程要 `createRequire(runtime/package.json).resolve('@diy-agent/compaction')` 就必须自己铺一份。
//
// 产物（构建产物，不进 git —— 见根 .gitignore）：
//   runtime/
//     package.json                        { name: "diy-runtime", private: true, type: "module" }
//     node_modules/@diy-agent/<pkg>/
//       package.json                      精简：只留 name / version / type / main / exports
//                                         + 内部依赖（@diy-agent/*，供 check-runtime-closure 判闭包）
//       lib/**                            只拷编译产物（js / d.ts / map），不拷 src / tests
//
// 纳入判据：`pkgs.ts/*/package.json` 里 `main` 以 `./lib/` 开头（##453 之后能力包都是）。
// @diy-agent/ui-kit 例外——它的 main 仍指 src（Solid JSX 不能由 tsc 产出），故不在产物里。
//
// 用法：node scripts/build-runtime.mjs [--quiet]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, ".."); // apps/diy-app
// ##512 起 diy-app 在 apps/ 下，能力包在 pkgs.ts/（分层），不再是「应用的上一级」
const pkgsDir = resolve(appDir, "../../pkgs.ts");
const outDir = join(appDir, "runtime");
const quiet = process.argv.includes("--quiet");
const log = (...a) => !quiet && console.log(...a);

/** 内部包 scope（runtime 里只有这些包，依赖闭包也只关心它们） */
const INTERNAL_SCOPES = ["@diy-agent/"];

/**
 * 精简 package.json：只留解析与 ESM 判型需要的字段。
 *
 * `dependencies` 只留**内部**（@diy-agent/*）——第三方依赖不随 runtime 分发（由打包产物自带），
 * 留着会让人误以为 runtime 里有它；而内部依赖是 check-runtime-closure 的判据来源（##455 #5）。
 */
function slimPackageJson(pkg) {
    const out = { name: pkg.name, version: pkg.version };
    if (pkg.type) out.type = pkg.type; // type: "module" 必须保留，否则 .js 按 CJS 解析即炸
    if (pkg.main) out.main = pkg.main;
    if (pkg.exports) out.exports = pkg.exports;
    const internalDeps = Object.fromEntries(
        Object.entries(pkg.dependencies ?? {}).filter(([name]) => INTERNAL_SCOPES.some((scope) => name.startsWith(scope))),
    );
    if (Object.keys(internalDeps).length > 0) out.dependencies = internalDeps;
    return out;
}

/**
 * 包目录（仓相对，如 `pkgs.ts/agent/bot`）：pkgs.ts 下**最多两层**。
 * 不能引入 scripts/workspace-dirs.mjs —— 本脚本会跟随发行物走，保持自包含。
 */
function packageDirs() {
    const out = [];
    const walk = (dir, depth) => {
        for (const entry of readdirSync(join(pkgsDir, dir), { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (existsSync(join(pkgsDir, rel, "package.json"))) out.push(rel);
            else if (depth > 1) walk(rel, depth - 1);
        }
    };
    walk("", 2);
    return out;
}

/** 收集要纳入 runtime 的包（main 指 ./lib/ 的才算） */
function collectPackages() {
    const picked = [];
    for (const dir of packageDirs()) {
        const pkgPath = join(pkgsDir, dir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg.main !== "string" || !pkg.main.startsWith("./lib/")) continue;
        const libDir = join(pkgsDir, dir, "lib");
        if (!existsSync(join(libDir, "index.js"))) {
            throw new Error(`${pkg.name}: main 指 ${pkg.main}，但 ${libDir}/index.js 不存在 —— 先跑根 ./sha.sh build（build-pkgs）`);
        }
        picked.push({ pkg, libDir });
    }
    return picked.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

function main() {
    const packages = collectPackages();
    if (packages.length === 0) throw new Error(`在 ${pkgsDir} 没找到 main 指 ./lib/ 的包 —— 构建前置是否缺失？`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(join(outDir, "node_modules", "@diy-agent"), { recursive: true });
    writeFileSync(
        join(outDir, "package.json"),
        `${JSON.stringify({ name: "diy-runtime", version: "0.0.0", private: true, type: "module" }, null, 4)}\n`,
    );

    for (const { pkg, libDir } of packages) {
        const dest = join(outDir, "node_modules", ...pkg.name.split("/"));
        mkdirSync(dest, { recursive: true });
        cpSync(libDir, join(dest, "lib"), { recursive: true });
        writeFileSync(join(dest, "package.json"), `${JSON.stringify(slimPackageJson(pkg), null, 4)}\n`);
        log(`  + ${pkg.name}@${pkg.version} (${pkg.main})`);
    }

    log(`runtime/ 生成完毕：${packages.length} 个包 → ${outDir}`);
}

main();
