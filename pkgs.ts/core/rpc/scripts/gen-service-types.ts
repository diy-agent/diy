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
 * 导出：名为 `xxxApi` 的常量（运行时是 `RpcSchema.router(...)` 返回的对象）
 * 产物：同目录 `api.generated.d.ts`
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderServiceTypes } from '../src/core/service-gen.js';

const checkOnly = process.argv.includes('--check');
/** scripts/ → rpc/ → core/ → pkgs.ts/ → 仓根 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_DIRS = ['pkgs.ts', 'apps'];

interface Target {
    file: string;
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
                acc.push({ file: join(full, 'api.ts'), out: join(full, 'api.generated.d.ts') });
            }
            stack.push(full);
        }
    }
    return acc;
}

function typeNameOf(exportName: string): string {
    const base = exportName.replace(/Api$/, '');
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
        const apis = Object.entries(mod).filter(([k, v]) => /Api$/.test(k) && v !== null && typeof v === 'object');
        if (apis.length === 0) continue;

        const generated = apis.map(([k, v]) => renderServiceTypes(typeNameOf(k), v as never)).join('\n');

        if (checkOnly) {
            const existing = existsSync(t.out) ? readFileSync(t.out, 'utf-8') : '';
            if (existing !== generated) {
                console.error(`✗ 生成物过期：${t.out.replace(ROOT + '/', '')}`);
                stale++;
            }
            continue;
        }
        writeFileSync(t.out, generated, 'utf-8');
        console.log(`✓ ${t.out.replace(ROOT + '/', '')}`);
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
