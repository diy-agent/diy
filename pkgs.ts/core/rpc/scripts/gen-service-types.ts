#!/usr/bin/env node
/**
 * gen-service-types.ts — 从各模块的 api.ts 生成 `api.generated.d.ts`
 *
 * 用法：
 *   tsx scripts/gen-service-types.ts          # 生成
 *   tsx scripts/gen-service-types.ts --check  # 只校验（过期则 exit 1）
 *
 * ## 为什么 --check 是必须的
 *
 * 生成物是**派生的** —— apiDef 改了但忘了跑生成器，就会留下"看着有类型、实际是旧的"
 * 文件，比没有类型更危险（调用方以为编译期挡住了，其实没有）。
 * CI / check 里跑 `--check`，diff 不为空即报错。
 *
 * ## 扫描约定
 *
 * 文件：`pkgs.ts/**` + `apps/**` 下的 `<dir>/src/api.ts`
 * 导出：**按形状识别**，不按名字（2026-11-06 修）——
 *   · `defineService(...)` 的返回值（有 `name` + `api` + `bind` + `use`）⇒ 用它自带的 name
 *   · 裸 `RpcSchema.router(...)` 的返回值（有 `_type` 或子节点）⇒ 用导出名推 typeName
 *   为什么不再按 `xxxApi` 后缀：workbench 导出的是 `workbenchRoutes` / `workbenchService`，
 *   按名字筛会静默跳过整个文件（比报错更难查）。
 * 产物：`<dir>/src/gen/<name>.generated.d.ts`（2026-11-06 用户定：生成物集中放 gen/，
 *       不跟手写代码混在同一层 —— 改 api.ts 时不会被一堆生成物挡住视线）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderServiceTypes } from '../src/core/service-gen.js';

const checkOnly = process.argv.includes('--check');
/** scripts/ → rpc/ → core/ → pkgs.ts/ → 仓根 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_DIRS = ['pkgs.ts', 'apps'];

interface Target {
    /** api.ts 的绝对路径 */
    file: string;
    /** 产物**目录**（`src/gen/`）；文件名按 `typeName` 一个 api 一个 */
    out: string;
}

function findApiFiles(dir: string, acc: Target[] = []): Target[] {
    const stack = [dir];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: import('node:fs').Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name === 'node_modules' || e.name === 'lib' || e.name === '.git' || e.name === 'dist') continue;
            const full = join(cur, e.name);
            if (e.name === 'src' && existsSync(join(full, 'api.ts'))) {
                acc.push({ file: join(full, 'api.ts'), out: join(full, 'gen') });
            }
            stack.push(full);
        }
    }
    return acc;
}

/**
 * 从一个导出值里取出 routes（router 树）。
 *   · defineService 的返回值 → `.api`
 *   · 裸 router 对象 → 它自己
 * 认不出返回 undefined。
 */
function routesOf(v: unknown): object | undefined {
    if (v === null || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    // defineService 的形状
    if (typeof o['bind'] === 'function' && typeof o['use'] === 'function' && o['api'] !== null && typeof o['api'] === 'object') {
        return o['api'] as object;
    }
    // 裸 router：值是对象且子节点都是对象（procedure / 子 router）
    const keys = Object.keys(o);
    if (keys.length === 0) return undefined;
    const looksLikeRouter = keys.every((k) => {
        const c = o[k];
        return typeof c === 'object' && c !== null;
    });
    return looksLikeRouter ? v : undefined;
}

function typeNameOf(exportName: string): string {
    const base = exportName.replace(/(Api|Routes|Service)$/, '');
    return base.charAt(0).toUpperCase() + base.slice(1);
}

async function main(): Promise<void> {
    const targets = SCAN_DIRS.flatMap((d) => findApiFiles(join(ROOT, d)));
    if (targets.length === 0) {
        console.log('[gen-service-types] 没有找到 api.ts（约定：`<dir>/src/api.ts`）');
        return;
    }

    let stale = 0;
    for (const t of targets) {
        const mod = (await import(pathToFileURL(t.file).href)) as Record<string, unknown>;
        // 按 routes **对象身份**去重：`workbenchRoutes` 与 `workbenchService.api` 是同一棵树，
        // 不去重会生成两份一模一样的 interface（TS 直接报重复声明）
        const seenRoutes = new Set<object>();
        const found: { key: string; routes: object }[] = [];
        for (const [k, v] of Object.entries(mod)) {
            const routes = routesOf(v);
            if (routes === undefined || seenRoutes.has(routes)) continue;
            seenRoutes.add(routes);
            found.push({ key: k, routes });
        }
        if (found.length === 0) continue;

        // **一个 api 一个文件**（2026-11-06）：同一文件放多个 api 会重复 `import type`，
        // oxlint 直接报 `Identifier 'RpcCallOptions' has already been declared`。
        // 文件名带 typeName 也更好定位（`gen/Workbench.generated.d.ts`）。
        mkdirSync(t.out, { recursive: true });
        for (const f of found) {
            const typeName = typeNameOf(f.key);
            const file = join(t.out, `${typeName}.generated.d.ts`);
            const generated = renderServiceTypes(typeName, f.routes as never);
            const rel = file.replace(ROOT + '/', '');

            if (checkOnly) {
                const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
                if (existing !== generated) {
                    console.error(`✗ 生成物过期：${rel}`);
                    stale++;
                }
                continue;
            }
            writeFileSync(file, generated, 'utf-8');
            console.log(`✓ ${rel}`);
        }
    }

    if (checkOnly) {
        if (stale > 0) {
            console.error(`\n[gen-service-types] ${stale} 个生成物过期 —— 跑一遍不带 --check 的生成`);
            process.exit(1);
        }
        console.log(`[gen-service-types] ✓ ${targets.length} 个 api.ts 的生成物都是最新的`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
