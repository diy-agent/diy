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
