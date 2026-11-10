#!/usr/bin/env node
// scripts/check-runtime-closure.mjs —— runtime/ 的 `@diy-agent/*` 依赖闭包检查（##455 #5）
//
// 为什么必须有：`WORKSPACE_TS_DEPS` 那次事故的核心 —— 包能加载但它的依赖不在，
// 只有运行到那行 import 才炸（且症状离根因很远）。这里是**静态**判据：
// 扫 `apps/diy-app/runtime/node_modules` 里每个包的 `dependencies`，
// 凡以 `` 开头的，必须也在同一份 runtime 里存在。
//
// 判据：
//   · runtime/ 未生成（干净 worktree / 没跑过 build）⇒ **跳过**（exit 0，带一行提示）——
//     与 check-specs.mts 同一条边界理由：本地没有产物时不该让 check 变红
//   · 有依赖缺失 ⇒ 列出「A 依赖 B，但 B 不在 runtime 里」并 exit 1
//
// 用法：
//   node scripts/check-runtime-closure.mjs              # 判（缺失即 exit 1）
//   node scripts/check-runtime-closure.mjs --runtime D  # 指定 runtime 目录
//   node scripts/check-runtime-closure.mjs --list       # 只列不判（看闭包现状）

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceDirs } from './workspace-dirs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argIdx = process.argv.indexOf("--runtime");
const RUNTIME_DIR = argIdx >= 0 ? resolve(process.argv[argIdx + 1]) : join(ROOT, "apps/diy-app/runtime");
const listOnly = process.argv.includes("--list");

/** 内部包的两个 scope（与 check-pkg-visibility 的「内部 = 非白名单」口径一致：只看这两个） */
const INTERNAL_SCOPES = ["@diy", "@diy-agent"];

function isInternal(name) {
    return INTERNAL_SCOPES.some((scope) => name.startsWith(`${scope}/`));
}

/**
 * runtime 该收哪些包：**只有 `main` 指 ./dist/ 或 ./lib/ 的**（与
 * apps/diy-app/scripts/build-runtime.mjs 的 collectPackages 同一判据）。
 *
 * 为什么判据要显式写出来（##522）：`@diy-agent/ui-design` 这类**纯资源包**（只有
 * exports 指向 .css、没有 main / 没有编译产物）天然不进 runtime —— 它的使用方在**打包期**
 * 就把它内联了（Tailwind / esbuild），运行时不会 `import "@diy-agent/ui-design"`。
 * 早先这里对「dependencies 里每个 @diy-agent/*」一刀切要求在场 ⇒ chat-page 声明了
 * ui-design 后 check 直接红，而 runtime 是对的。资源包单列一条提示，不算缺失。
 */
function isRuntimePackage(pkg) {
    return typeof pkg?.main === 'string' && /^\.\/(dist|lib)\//.test(pkg.main);
}

/** 仓内某包名 → package.json（判「依赖的那个包是不是资源包」用） */
function workspaceManifest(name) {
    for (const dir of workspaceDirs(ROOT)) {
        const file = join(ROOT, dir, 'package.json');
        if (!existsSync(file)) continue;
        try {
            const pkg = JSON.parse(readFileSync(file, 'utf8'));
            if (pkg.name === name) return pkg;
        } catch {
            // 坏 package.json 不归本脚本管（check 别处会红）
        }
    }
    return null;
}

/** 收集 runtime 里的全部包：name → package.json */
function collectRuntimePackages() {
    const out = new Map();
    const nm = join(RUNTIME_DIR, "node_modules");
    for (const scope of INTERNAL_SCOPES) {
        const scopeDir = join(nm, scope);
        if (!existsSync(scopeDir)) continue;
        for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = join(scopeDir, entry.name, "package.json");
            if (!existsSync(file)) continue;
            const pkg = JSON.parse(readFileSync(file, "utf8"));
            const name = typeof pkg.name === "string" ? pkg.name : `${scope}/${entry.name}`;
            out.set(name, { pkg, dir: join(scopeDir, entry.name) });
        }
    }
    return out;
}

function main() {
    if (!existsSync(join(RUNTIME_DIR, "package.json"))) {
        console.log(`[runtime-closure] 跳过：${RUNTIME_DIR} 未生成（先跑 node apps/diy-app/scripts/build-runtime.mjs）`);
        return;
    }

    const packages = collectRuntimePackages();
    if (packages.size === 0) {
        console.error(`[runtime-closure] ✗ ${RUNTIME_DIR}/node_modules 里没有任何 @diy-agent/* 包 —— 产物异常`);
        process.exit(1);
    }

    const rows = [];
    const problems = [];
    const resources = new Map(); // 依赖到的纯资源包：name → 依赖它的包集合
    for (const [name, { pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const deps = Object.keys(pkg.dependencies ?? {}).filter(isInternal);
        for (const dep of deps) {
            if (packages.has(dep)) {
                rows.push(`  ✓ ${name} → ${dep}`);
            } else if (!isRuntimePackage(workspaceManifest(dep))) {
                // 资源包（CSS / 静态资源）：打包期处理，不属于 Node 运行时闭包
                if (!resources.has(dep)) resources.set(dep, new Set());
                resources.get(dep).add(name);
            } else {
                problems.push(`${name} 依赖 ${dep}，但 ${dep} 不在 runtime 里`);
            }
        }
    }

    if (listOnly) {
        console.log(`[runtime-closure] ${packages.size} 个包，${rows.length} 条内部依赖：`);
        for (const row of rows) console.log(row);
        return;
    }

    if (problems.length > 0) {
        console.error(`[runtime-closure] ✗ 依赖闭包缺失 ${problems.length} 处（runtime = ${RUNTIME_DIR}）：`);
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error("  处置：确认源包 package.json 的 dependencies 是否需要该包；再跑 node apps/diy-app/scripts/build-runtime.mjs");
        process.exit(1);
    }

    for (const [dep, users] of resources) {
        console.log(
            `  · ${dep} 是资源包（无 dist/lib 入口），不进 runtime —— 使用方打包期内联：${[...users].join(', ')}`,
        );
    }
    console.log(`[runtime-closure] ✓ 通过（${packages.size} 个包 / ${rows.length} 条 @diy-agent 内部依赖全部在闭包内）`);
}

main();
