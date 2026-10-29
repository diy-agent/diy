#!/usr/bin/env node
// scripts/check-pkg-visibility.mjs —— 包可见性白名单（2026-10-28，已接 ./sha.sh check）
//
// 判据（用户 2026-10-28：「除了 rpc/ui 两个包外目前都是 private，白名单」）：
//   ① **对外发布白名单** = `@diy-agent/rpc` · `@diy-agent/ui` —— 这两个**不许** `private: true`
//      （带了就发不出去：npm publish 会直接拒绝，--force 也不行）
//   ② 其余所有包（`@diy/*`、`diy-app`、`diy-dev`、`workbench-plugin`）**必须** `private: true`
//   ③ `@diy-agent/*`（对外）**不许依赖** `@diy/*`（内部）—— 一旦依赖，那个内部包事实上就被发布了：
//      使用者装上对外包后，npm 会去 registry 找这个内部包 ⇒ 404 或误装同名包
//
// 为什么用脚本而不是写进文档：能自动判的别靠人记（同 ##442「能推导的不许让用户设」的思路）。
//
// 用法：
//   node scripts/check-pkg-visibility.mjs          # 扫全量，违规即 exit 1
//   node scripts/check-pkg-visibility.mjs --list   # 只列不判（看现状）

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKGS_DIR = join(ROOT, "pkgs.ts");

/** 对外发布白名单（**唯一真源**；加一个包 = 改这里 + 去掉它的 private） */
const PUBLIC_PACKAGES = new Set(["@diy-agent/rpc", "@diy-agent/ui"]);

const listOnly = process.argv.includes("--list");

// 收集 pkgs.ts 下每个包的 package.json + 根 package.json（不要写成块注释：路径里的星号斜杠会提前结束注释）
function collect() {
    const out = [];
    const rootPkg = join(ROOT, "package.json");
    if (existsSync(rootPkg)) out.push({ dir: ".", file: rootPkg });
    for (const name of readdirSync(PKGS_DIR, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const file = join(PKGS_DIR, name.name, "package.json");
        if (existsSync(file)) out.push({ dir: name.name, file });
    }
    return out;
}

/** 从 package.json 里取全部依赖名（含 dev / peer / optional） */
function depNames(pkg) {
    const out = new Set();
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = pkg[key];
        if (!deps || typeof deps !== "object") continue;
        for (const dep of Object.keys(deps)) out.add(dep);
    }
    return [...out];
}

const pkgs = collect();
const problems = [];
const rows = [];

for (const { dir, file } of pkgs) {
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        problems.push(`${dir}: package.json 解析失败 —— ${e.message}`);
        continue;
    }
    const name = String(pkg.name ?? "(无名)");
    const isPrivate = pkg.private === true;
    const shouldBePublic = PUBLIC_PACKAGES.has(name);
    rows.push({ dir, name, isPrivate, shouldBePublic });

    // ① 对外：不许 private
    if (shouldBePublic && isPrivate) {
        problems.push(
            `${name}: 在对外发布白名单里却带了 "private": true —— npm publish 会被直接拒绝（--force 也不行）。去掉该字段。`,
        );
    }
    // ② 内部：必须 private
    if (!shouldBePublic && !isPrivate && dir !== ".") {
        problems.push(
            `${name}: 不在对外发布白名单里，却缺少 "private": true —— 可能被误发布。` +
                `若确需发布，把它加进 scripts/check-pkg-visibility.mjs 的 PUBLIC_PACKAGES。`,
        );
    }
    // ③ 对外包不许依赖内部包
    if (shouldBePublic) {
        const bad = depNames(pkg).filter((d) => d.startsWith("@diy/"));
        if (bad.length > 0) {
            problems.push(
                `${name}: 对外包依赖了内部包 ${bad.join(", ")} —— 使用者装它会去 registry 找这些内部包（404 或误装同名包）。` +
                    `请把这些依赖内联、或改成不发依赖的实现。`,
            );
        }
    }
}

if (listOnly) {
    console.log(`包可见性现状（${rows.length} 个）:`);
    for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
        const flag = r.shouldBePublic ? "对外" : "内部";
        console.log(`  ${r.name.padEnd(30)} ${flag}  private=${r.isPrivate}`);
    }
    process.exit(0);
}

// ── ⑤ 包的**类型入口**不许指向 lib/（2026-10-29 事故）────────────────────────
// 事故：#453 把各包 `main` 指向 `./lib/index.js` 时，`types` 也一起指向 `./lib/index.d.ts`。
// 而 `lib/` 在 `.gitignore` 里（产物不入库）⇒ **任何没跑过 build-pkgs 的仓库**
// 类型解析全失败（实测 main 上 52 个 error TS，`Cannot find module '@diy/agent-session'`），
// 而跑过 build 的 worktree 里 check 是绿的 —— 典型的「验了脏工作区，没验干净态」。
//
// 判据：`types` 与 `exports.*.types` 一律指 `./src/…`（tsc 直接读 TS 源，不依赖产物）；
//       `main` / `exports.*.default` 保持指 `./lib/…`（运行时 Node 加载）。
{
    for (const file of readdirSync(PKGS_DIR).map((d) => join(PKGS_DIR, d, "package.json")).filter(existsSync)) {
        let pkg;
        try { pkg = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
        const bad = [];
        if (String(pkg.types ?? "").startsWith("./lib/")) bad.push(`types: ${pkg.types}`);
        for (const [k, v] of Object.entries(pkg.exports ?? {})) {
            if (v && typeof v === "object" && String(v.types ?? "").startsWith("./lib/")) {
                bad.push(`exports["${k}"].types: ${v.types}`);
            }
        }
        if (bad.length) {
            problems.push(
                `${pkg.name}: 类型入口指向 lib/（${bad.join(" / ")}）—— lib 不入库，干净仓库会 Cannot find module。` +
                    ` 改成 ./src/…（main 仍指 lib）。`,
            );
        }
    }
}

if (problems.length > 0) {
    console.error(`✗ 包可见性白名单：${problems.length} 处违规`);
    for (const p of problems) console.error(`  · ${p}`);
    console.error(`\n  白名单真源：scripts/check-pkg-visibility.mjs 的 PUBLIC_PACKAGES`);
    process.exit(1);
}

const publicCount = rows.filter((r) => r.shouldBePublic).length;
console.log(
    `✓ 包可见性通过（${rows.length} 个包：对外 ${publicCount} 个 = ${[...PUBLIC_PACKAGES].join(" / ")}，其余 private）`,
);

// ── ④ workspace 打包清单（2026-10-28 追加，##266 实测事故）──────────────────
// 事故：拆出 @diy/context / @diy/compact / @diy/ui-kit 后忘了加进 diy-app 的
// `vite.pkg-deps.ts::WORKSPACE_TS_DEPS` ⇒ 产物里留下裸 `import "@diy/context/…"` ⇒
// Electron 启动即 `ERR_MODULE_NOT_FOUND`，**intent 测试全 skipped**，而 `./sha.sh check`
// 与单元测试全绿（它们不走打包路径）—— 出一条「check 绿但跑不起来」的隐性红。
//
// 判据：diy-app 的 dependencies 里每个 `@diy/*`，都必须在 WORKSPACE_TS_DEPS 里出现。
{
    const pkgDepsFile = join(PKGS_DIR, "diy-app", "vite.pkg-deps.ts");
    const appPkgFile = join(PKGS_DIR, "diy-app", "package.json");
    if (existsSync(pkgDepsFile) && existsSync(appPkgFile)) {
        const src = readFileSync(pkgDepsFile, "utf8");
        const block = src.match(/WORKSPACE_TS_DEPS\s*=\s*\[([\s\S]*?)\]/);
        const listed = new Set(
            [...(block?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
        );
        const appPkg = JSON.parse(readFileSync(appPkgFile, "utf8"));
        const needed = Object.keys(appPkg.dependencies ?? {}).filter((d) => d.startsWith("@diy/"));
        const missing = needed.filter((d) => !listed.has(d));
        if (missing.length > 0) {
            problems.push(
                `diy-app 依赖了 ${missing.join(", ")}，但 vite.pkg-deps.ts 的 WORKSPACE_TS_DEPS 里没有` +
                    ` —— 产物会留裸 import ⇒ Electron 启动即 ERR_MODULE_NOT_FOUND（intent 全 skipped，而 check 仍绿）。`,
            );
        }
    }
}

// ── ⑤ 包出口不许再指 `.ts`（2026-10-29 追加，##453 薄壳子前置 #1~#2）────────────
// 事故背景：Electron 要从 `Resources/runtime/node_modules/` **动态加载能力包**，那是
// Node 直接 `import()` —— Node 加载不了 `.ts`。原先 11 个包的 main 全指 `./src/index.ts`，
// 「打包时才发现加载不了」。判据：main / exports 的出口必须以 `.js` 结尾（产物是 lib/）。
// 修法：每包 `tsconfig.build.json`（outDir=lib）→ `./sha.sh build` → main 指 `./lib/index.js`。
//
// 例外（判据：**Node 能不能真的加载**）：`@diy/ui-kit` 是 Solid JSX 组件库 —— JSX 必须由
// 渲染端编译器（vite 的 solid 插件）编译，tsc 只能 `jsx: preserve` 出带 JSX 的 `.js`（Node 解析即炸），
// 故它没有 lib、只被 vite 打进 renderer，出口保持 `./src/index.ts`。
const TS_ENTRY_EXEMPT = new Set(["@diy/ui-kit"]);
{
    for (const { dir, file } of pkgs) {
        let pkg;
        try {
            pkg = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            continue; // 解析失败已在上面报过
        }
        if (TS_ENTRY_EXEMPT.has(pkg.name)) continue;
        const bad = [];
        if (typeof pkg.main === "string" && pkg.main.endsWith(".ts")) bad.push(`main=${pkg.main}`);
        for (const [key, value] of Object.entries(pkg.exports ?? {})) {
            const spec = typeof value === "string" ? value : (value?.default ?? value?.import);
            if (typeof spec === "string" && spec.endsWith(".ts")) bad.push(`exports["${key}"]=${spec}`);
        }
        if (bad.length > 0) {
            problems.push(
                `${pkg.name}: 出口仍指向 .ts（${bad.join(", ")}）—— Node 加载不了 .ts，` +
                    `Electron 从 node_modules 动态加载时会 ERR_UNKNOWN_FILE_EXTENSION。` +
                    `应指 ./lib/*.js（先 ./sha.sh build）。`,
            );
        }
    }
}

// 上面第 ④ 段在 problems 已打印之后才追加，故此处重新判定一次
if (problems.length > 0) {
    console.error(`✗ 包可见性白名单：${problems.length} 处违规`);
    for (const p of problems) console.error(`  · ${p}`);
    console.error(`\n  白名单真源：scripts/check-pkg-visibility.mjs 的 PUBLIC_PACKAGES / vite.pkg-deps.ts`);
    process.exit(1);
}
