#!/usr/bin/env node
// scripts/check-renderer-boundary.mjs —— renderer 图不许出现 node / electron（2026-11-04）
//
// 为什么要有（真事故）：2026-11-04 prod 产物 `index-92oAXqGe.js:347` 抛
//   ReferenceError: process is not defined ⇒ 窗口纯黑。
// 链：`shared/run-view` → `shared/run-status`（写成 `export * from "@diy-agent/jobs"`）
//     → 包入口 barrel 带出 run-registry → @diy-agent/tools/shell/run → node:child_process
//     → 后者**模块顶层**读 process.platform。
//
// 为什么 tsc / oxlint / check-os-boundary 都抓不到：
//   · tsc 只做类型检查，看不出「运行时会不会求值到」
//   · oxlint 不分析跨包 import 图
//   · check-os-boundary 是**文本正则**扫令牌，而这次的 process.platform 在 node_modules 深处，
//     源码里只有一行 `export * from "@diy-agent/jobs"` —— 字面上完全干净
// ⇒ 需要**真遍历 import 图**。
//
// 判据：
//   · 从各 renderer 入口出发，递归解析 import / export-from
//   · `import type` / `export type` **跳过**（编译期擦除，不进运行时）
//   · 遇到 node: / 内置模块名 / electron ⇒ 报错，打印完整来源链
//   · @diy-agent/* 走 package.json 的 exports 或 src/ 推断
//
// 与 vite.renderer.config 的 browserSafe 插件分工：
//   · 本脚本：check 阶段（秒级、给来源链、PR 可拦）
//   · 插件：build 阶段（最后一道，且能处理动态 resolve）
// 两层都要：插件依赖 Vite 的解析行为（版本/插件顺序会变），脚本是纯静态、稳定。
//
// 用法：
//   node scripts/check-renderer-boundary.mjs           # 判（有越界 exit 1）
//   node scripts/check-renderer-boundary.mjs --list    # 只列入口与统计
//   node scripts/check-renderer-boundary.mjs --self-test  # 注入已知事故，断言能抓到

import { readFileSync, existsSync, statSync, globSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => "node:" + m)]);

/** 入口：renderer 的根文件（页面从这里开始渲染） */
const ENTRIES = [
    "apps/diy-app/src/renderer_solid/main.tsx",
    "apps/diy-app/src/renderer_solid/index.tsx",
    "pkgs.ts/ui/chat-page/src/renderer-diui.ts",
    "pkgs.ts/ui/chat-page/src/renderer.ts",
    "pkgs.ts/ui/bot-config/src/renderer.ts",
];

// ── 包名 → 目录（读根 package.json 的 workspaces，别手维护映射表）──
// 注意 workspaces 支持**多层通配**（`pkgs.ts/*/*` = 组/包），不能只去掉最后一层 `/*`。
const workspaces = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).workspaces ?? [];
const pkgDirs = new Map();
for (const pattern of workspaces) {
    for (const pjRel of globSync(join(pattern, "package.json"), { cwd: ROOT })) {
        const dir = join(ROOT, dirname(pjRel));
        try {
            const { name: pkgName } = JSON.parse(readFileSync(join(ROOT, pjRel), "utf-8"));
            if (pkgName) pkgDirs.set(pkgName, dir);
        } catch { /* 坏 package.json 不是本脚本的事 */ }
    }
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const tryFile = (p) => {
    for (const c of [p, p + ".ts", p + ".tsx", join(p, "index.ts"), join(p, "index.tsx")]) if (isFile(c)) return c;
    return null;
};

/** 解析一条 specifier → { file } 或 { builtin } 或 null（不认识的跳过） */
function resolveSpec(spec, fromFile) {
    if (BUILTIN.has(spec) || spec === "electron") return { builtin: spec };
    if (spec.startsWith(".")) {
        const f = tryFile(resolve(dirname(fromFile), spec.replace(/\.js$/, "")));
        return f ? { file: f } : null;
    }
    if (!spec.startsWith("@diy-agent/")) return null;
    const parts = spec.split("/");
    const pkgName = parts.slice(0, 2).join("/");
    const sub = parts.slice(2).join("/");
    const dir = pkgDirs.get(pkgName);
    if (!dir) return null;
    const bases = sub ? [join(dir, "src", sub)] : [join(dir, "src", "index")];
    for (const b of bases) { const f = tryFile(b); if (f) return { file: f }; }
    return null;
}

/** import / export-from；`type` 修饰的跳过（编译期擦除） */
const IMPORT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;\n]*?from\s+["']([^"']+)["']/g;

function walk(entry, problems, visited) {
    const stack = [[entry, []]];
    while (stack.length > 0) {
        const [file, chain] = stack.pop();
        if (visited.has(file)) continue;
        visited.add(file);
        const text = readFileSync(file, "utf-8");
        for (const m of text.matchAll(IMPORT_RE)) {
            if (m[2] !== undefined) continue; // import type / export type
            const spec = m[3];
            const r = resolveSpec(spec, file);
            if (r === null) continue;
            const here = [...chain, relative(ROOT, file)];
            if (r.builtin) { problems.push([...here, `${r.builtin}  ← ${relative(ROOT, file)}`]); continue; }
            stack.push([r.file, here]);
        }
    }
}

function scan() {
    const problems = [];
    const visited = new Set();
    for (const e of ENTRIES) {
        const f = join(ROOT, e);
        if (isFile(f)) walk(f, problems, visited);
    }
    return { problems: dedupe(problems), visited: visited.size };
}

/** 同一处问题会被多条路径重复发现；按「终点 + 最后一跳」去重，但保留最短链 */
function dedupe(problems) {
    const byKey = new Map();
    for (const p of problems) {
        const key = p.at(-1);
        const prev = byKey.get(key);
        if (prev === undefined || p.length < prev.length) byKey.set(key, p);
    }
    return [...byKey.values()].sort((a, b) => a.length - b.length);
}

/**
 * `--barrels`：审计**每个包的 barrel 是否危险**（index.ts 能否到达 node/electron）。
 *
 * 和主检查不同 —— 主检查看「renderer 实际图里有没有越界」（会阻断）；
 * 这个是**参考清单**：告诉你哪些包的 `export *` 不能用，防止未来误用。
 * 结果写进 docs/package-boundaries.md。
 */
function auditBarrels() {
    const risky = [];
    const safe = [];
    for (const [name, dir] of [...pkgDirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const idx = tryFile(join(dir, "src", "index"));
        if (idx === null) continue;
        // 复用同一个 walk：从 index 出发，找第一条到达 builtin 的链
        const found = [];
        walk(idx, found, new Set());
        if (found.length > 0) risky.push([name, found[0]]);
        else safe.push(name);
    }
    console.log(`\n=== barrel 危险（index.ts 可达 node/electron）：${risky.length} 个 ===`);
    for (const [name, chain] of risky) {
        // chain 最后一项已经是 `node:xxx  ← 出处文件` 的完整描述
        console.log(`  ${name.padEnd(32)} → ${chain.at(-1)}`);
    }
    console.log(`\n=== barrel 安全：${safe.length} 个 ===`);
    console.log("  " + safe.join(", "));
    console.log("\n改包结构后请更新 docs/package-boundaries.md 的清单。");
}

const arg = process.argv[2];
if (arg === "--self-test") {
    // 注入事故链：把一个 renderer 可达的转发层改成 barrel 引用，断言脚本能抓到
    const probe = join(ROOT, "apps/diy-app/src/shared/run-view.ts");
    if (!isFile(probe)) { console.error("self-test 跳过：探针文件不存在"); process.exit(0); }
    const { writeFileSync } = await import("node:fs");
    const original = readFileSync(probe, "utf-8");
    const patched = original.replace(/from\s+["']\.\/run-status["']/, 'from "@diy-agent/jobs"');
    if (patched === original) {
        console.error("self-test 跳过：探针里没有 ./run-status 引用（事故形态已变，请更新探针）");
        process.exit(0);
    }
    // ⚠️ 恢复必须在 exit **之前**：`process.exit()` 不执行 finally，
    //    之前用 try/finally 恢复，结果每次 --self-test 都把脏文件留在工作区。
    let hit = false;
    try {
        writeFileSync(probe, patched, "utf-8");
        const { problems } = scan();
        hit = problems.some((p) => p.at(-1)?.includes("node:child_process"));
    } finally {
        writeFileSync(probe, original, "utf-8");
    }
    console.log(hit ? "✓ self-test 通过（能抓到 barrel 事故）" : "✗ self-test 失败：注入事故后仍无告警");
    process.exit(hit ? 0 : 1);
}

const { problems, visited } = scan();
if (arg === "--barrels") {
    auditBarrels();
    process.exit(0);
}

if (arg === "--list") {
    console.log(`入口 ${ENTRIES.filter((e) => isFile(join(ROOT, e))).length} 个 · 扫了 ${visited} 个文件`);
    process.exit(0);
}
if (problems.length === 0) {
    console.log(`[check-renderer-boundary] ✓ 通过：${visited} 个 renderer 文件，无 node/electron`);
    process.exit(0);
}
console.error(`[check-renderer-boundary] ✗ renderer 图里有 ${problems.length} 处 node/electron：\n`);
for (const p of problems) console.error("  ✗ " + p.join("\n     → ") + "\n");
console.error("修法：转发层别用 `export * from \"@diy-agent/<pkg>\"`（barrel 会带出 Node 侧能力），");
console.error("      改成具体子路径，如 `@diy-agent/jobs/run-status`。");
process.exit(1);
