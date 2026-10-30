#!/usr/bin/env node
// scripts/build-order.mjs —— 能力包（pkgs.ts/*）的构建顺序：自动发现 + 依赖拓扑排序
//
// 为什么有这个脚本：`build-pkgs` 原先是手写数组 `_pkg_order`，**两次漏登记新包**
//   · #465 新增 @diy-agent/model-catalog → 补数组（76ba6f46）
//   · #469 新增 @diy-agent/bot       → 又漏（本脚本的由来）
// 漏登记的后果不是「少编一个包」这么直白：build-runtime 收集 main 指 ./lib/ 的包时，
// 撞见没 lib/index.js 就抛「先跑根 ./sha.sh build」—— 而那条命令正是刚失败的那条，
// 人是被提示引去重跑同一个东西。所以改成机器发现，不再有「登记」这道手工程序。
//
// 判据：
//   · 入选 = pkgs.ts/<dir>/package.json 且 `main` 以 `./lib/` 开头（= 需要编 lib/ 的能力包）。
//     这不是新口径，正是 diy-app/scripts/build-runtime.mjs 收集 runtime 的那条判据。
//   · 顺序 = 内部依赖（@diy/* · @diy-agent/*）拓扑序，被依赖方在前。
//     为什么必须有顺序：各包 tsc 靠被依赖包的 lib/*.d.ts 做类型解析，故不能乱序、也不能并行。
//   · 同一批可编的包之间按目录名字典序 —— 输出稳定，构建日志可 diff。
//
// 用法：
//   node scripts/build-order.mjs           # 一行一个包目录名，供 build-pkgs 循环
//   node scripts/build-order.mjs --json    # [{ dir, name }]
// 退出码：有环 / manifest 读不出 ⇒ 1（并打印卡住的那批包名）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKGS_DIR = join(ROOT, "pkgs.ts");
/** 内部包的 scope（与 check-runtime-closure.mjs / check-pkg-visibility.mjs 同口径） */
const INTERNAL_SCOPES = ["@diy", "@diy-agent"];

const isInternal = (name) => INTERNAL_SCOPES.some((scope) => name.startsWith(`${scope}/`));
const asJson = process.argv.includes("--json");

/** 收集需要编 lib/ 的包：dir → { dir, name, deps } */
function collectPackages() {
    const out = new Map();
    for (const entry of readdirSync(PKGS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = join(PKGS_DIR, entry.name, "package.json");
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg.main !== "string" || !pkg.main.startsWith("./lib/")) continue;
        const deps = new Set(
            [
                ...Object.keys(pkg.dependencies ?? {}),
                ...Object.keys(pkg.peerDependencies ?? {}),
            ].filter(isInternal),
        );
        out.set(pkg.name, { dir: entry.name, name: pkg.name, deps });
    }
    return out;
}

/** Kahn 拓扑排序；同层按目录名排序 ⇒ 输出稳定 */
function topoSort(packages) {
    const byName = new Map([...packages.values()].map((p) => [p.name, p]));
    /** 入边：name → 依赖它的包 */
    const dependents = new Map([...byName.keys()].map((n) => [n, []]));
    const indegree = new Map([...byName.keys()].map((n) => [n, 0]));
    for (const pkg of byName.values()) {
        for (const dep of pkg.deps) {
            if (!byName.has(dep)) continue; // 依赖方不编 lib（如 @diy-agent/ui-kit）⇒ 无顺序约束
            dependents.get(dep).push(pkg.name);
            indegree.set(pkg.name, indegree.get(pkg.name) + 1);
        }
    }

    const ready = [...byName.keys()].filter((n) => indegree.get(n) === 0);
    const order = [];
    while (ready.length > 0) {
        ready.sort((a, b) => byName.get(a).dir.localeCompare(byName.get(b).dir));
        const name = ready.shift();
        order.push(byName.get(name));
        for (const next of dependents.get(name)) {
            indegree.set(next, indegree.get(next) - 1);
            if (indegree.get(next) === 0) ready.push(next);
        }
    }

    if (order.length !== byName.size) {
        const stuck = [...byName.keys()].filter((n) => indegree.get(n) > 0).sort();
        throw new Error(`内部依赖成环，以下包排不出顺序：${stuck.join(", ")}`);
    }
    return order;
}

const order = topoSort(collectPackages());
if (order.length === 0) {
    console.error("pkgs.ts/ 下没找到 main 指 ./lib/ 的包 —— build-pkgs 无从下手");
    process.exit(1);
}
if (asJson) {
    console.log(JSON.stringify(order.map(({ dir, name }) => ({ dir, name })), null, 4));
} else {
    console.log(order.map((p) => p.dir).join("\n"));
}
