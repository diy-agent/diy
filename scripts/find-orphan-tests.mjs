#!/usr/bin/env node
/**
 * find-orphan-tests.mjs — 找「孤儿测试」：测的代码在生产路径上已经没人用了
 *
 * 为什么需要：重构/迁移后经常出现两种残骸，knip 只报第一种 ——
 *   ① 死代码：文件谁都不 import（knip 的 unused files）
 *   ② **孤儿测试**：生产代码还在，但**只有测试**在 import 它（knip 不报，因为测试算引用）
 * 第 ② 种最危险：测试是绿的，让人以为这块还活着，实际早被别处替代。
 *
 * 判据：一个源文件如果**只被测试文件** import（没有任何非测试文件 import），就是孤儿。
 *   例外：入口文件（main/index.ts 等）由 esbuild/vite 配置引用，不在 import 图里 —— 排除。
 *
 * 用法：node scripts/find-orphan-tests.mjs [--verbose]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const SRC_ROOTS = ["pkgs.ts", "apps"];
const SKIP = new Set(["node_modules", "lib", "build", "dist", ".git", "gen"]);

/** 递归收集 .ts/.tsx 文件 */
function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
}

/** 从文件里抽出相对 import 的目标（绝对路径，猜 .ts/.tsx/index） */
function importsOf(file) {
    const body = readFileSync(file, "utf-8");
    const out = new Set();
    const re = /from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
    for (const m of body.matchAll(re)) {
        const spec = m[1] ?? m[2];
        let base = resolve(dirname(file), spec.replace(/\.js$/, ""));
        for (const cand of [base + ".ts", base + ".tsx", base + ".mjs", base + ".mts", join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.mjs")]) {
            try {
                if (statSync(cand).isFile()) { out.add(cand); break; }
            } catch { /* 试下一个 */ }
        }
    }
    return out;
}

const all = SRC_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const isTest = (f) => /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec|probe|golden)\.(ts|tsx)$/.test(f);

// 反向索引：目标文件 → 谁 import 了它
const importers = new Map();
for (const f of all) {
    for (const t of importsOf(f)) {
        if (!importers.has(t)) importers.set(t, []);
        importers.get(t).push(f);
    }
}

/**
 * 生产入口：由构建配置（esbuild / vite）或 package.json exports 引用，不在 import 图里。
 * 这里用保守白名单 —— 宁可漏报也不误报（误报会让人去删真正有用的文件）。
 */
const ENTRY_HINTS = [
    /\/index\.tsx?$/,
    /\/main\.ts$/,
    /\/preload\.ts$/,
    /\/renderer\.ts$/,
    /\/main-memory\.mjs$/,
    // 示例代码：只给文档 / 测试当范例用，生产不会 import 它们（import 了才奇怪）
    /\/examples\//,
    // 构建配置里以**字符串**给出的入口（esbuild entryPoints 等）—— 静态 import 图看不见
    /^apps\/web\/server\.ts$/,        // apps/web/main.mjs:97 entryPoints

];

const orphans = [];
for (const [target, importersList] of importers) {
    if (isTest(target)) continue;
    const by = importersList.filter((f) => !isTest(f));
    if (by.length > 0) continue;                       // 有生产引用 ⇒ 正常
    if (ENTRY_HINTS.some((re) => re.test(target))) continue; // 入口文件，白名单
    if (importersList.length === 0) continue;          // 谁都不引 —— 那是 knip 的活
    orphans.push({ target: relative(ROOT, target), tests: importersList.map((f) => relative(ROOT, f)) });
}

if (orphans.length === 0) {
    console.log("✅ 没有孤儿测试（每个源文件都至少有 1 个非测试引用）");
    process.exit(0);
}

console.log(`⚠️  发现 ${orphans.length} 个「只被测试引用」的源文件：\n`);
for (const o of orphans) {
    console.log(`  ${o.target}`);
    for (const t of o.tests) console.log(`      ← ${t}`);
    if (VERBOSE) {
        try {
            const head = readFileSync(join(ROOT, o.target), "utf-8").split("\n").slice(0, 3).join(" ");
            console.log(`      内容开头：${head.slice(0, 110)}`);
        } catch { /* ignore */ }
    }
    console.log();
}
console.log(`怎样处置：`);
console.log(`  · 转发壳（export * from "@diy-agent/..."）→ 生产已改用公共包，删壳 + 改测试 import 到公共包`);
console.log(`  · 真死代码 → 删文件 + 删测试`);
console.log(`  · 靠动态 import / 构建配置引用 → 加进 ENTRY_HINTS 白名单（并在注释里写原因）`);
process.exit(1);
