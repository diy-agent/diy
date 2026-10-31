#!/usr/bin/env node
// scripts/npm-publish-app.mjs — 把 apps/* 的**运行产物**组装成发行形态并发布（##478）。
//
// 与 scripts/npm-publish.mjs（能力包）的区别：
//   · 能力包发的是 lib/（`tsc` 产物，`exports` 指 `*.js`）；
//   · app 发的是 `build/<variant>/` 三份 esbuild 产物 + `bin/` 入口，没有 `exports`，
//     `main` 指 `build/main/index.mjs`，`bin` 指 `bin/<app>.mjs`。
// 共同部分（认证 / registry / 内部依赖版本）走 ./npm-publish-common.mjs。
//
// 为什么非要脚本（2026-10-30 事故）：app-chat@0.1.0 是**手工**攒 dist/ 发出去的 ——
// bin/diy-chat.mjs 只存在于某个人的磁盘上，仓库里没有；此后想修发布体验都无从下手。
// 现在「发布形态」由本脚本定义，源码在 apps/<app>/bin/ 里入库。
//
// 用法：
//   node scripts/npm-publish-app.mjs <appDir> [--variant=lab] [--prepare-only] [--dry-run]
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publishDir, releaseManifest, workspacePackages } from './npm-publish-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const appDirArg = args.find((a) => !a.startsWith('-'));
if (!appDirArg) {
    console.error('用法: node scripts/npm-publish-app.mjs <appDir> [--variant=lab] [--prepare-only] [--dry-run]');
    process.exit(2);
}

const appDir = path.resolve(appDirArg);
const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const variant = opt('variant', 'lab');
const stageDir = path.join(appDir, opt('out', 'dist'));
const buildDir = path.join(appDir, 'build', variant);

const required = ['main/index.mjs', 'preload/index.cjs', 'renderer/index.html', 'renderer/index.js'];
const missing = required.filter((f) => !existsSync(path.join(buildDir, f)));
if (missing.length) {
    console.error(`✗ build/${variant} 不完整（缺 ${missing.join(' / ')}）—— 先 ./sha.sh build`);
    process.exit(1);
}
if (!existsSync(path.join(appDir, 'bin'))) {
    console.error('✗ 缺 bin/ 目录（app 的 CLI 入口必须入库，见 ##478）');
    process.exit(1);
}

// ── 组装 ────────────────────────────────────────────────
rmSync(stageDir, { recursive: true, force: true });
cpSync(path.join(appDir, 'bin'), path.join(stageDir, 'bin'), { recursive: true });
cpSync(buildDir, path.join(stageDir, 'build'), { recursive: true });

// bin 必须可执行：npm 会按 package.json 的 bin 建软链，但 tarball 里丢了 +x 就只能 `node 路径`
for (const entry of Object.values(pkg.bin ?? {})) {
    const file = path.join(stageDir, entry.replace(/^\.\//, ''));
    if (!existsSync(file)) continue;
    chmodSync(file, statSync(file).mode | 0o111);
}

const versions = workspacePackages(path.resolve(appDir, '../..'));
const manifest = releaseManifest(pkg, versions);
manifest.main = './build/main/index.mjs';
manifest.bin = pkg.bin;
manifest.files = ['bin/', 'build/'];

const outFile = path.join(stageDir, 'package.json');
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ 生成发行版 ${path.relative(process.cwd(), stageDir)}/package.json`);
console.log(`  name=${manifest.name}@${manifest.version} main=${manifest.main} bin=[${Object.keys(manifest.bin ?? {}).join(', ')}]`);
console.log(`  dependencies=[${Object.keys(manifest.dependencies ?? {}).join(', ')}]`);

if (flag('prepare-only')) process.exit(0);
publishDir(stageDir, { dryRun: flag('dry-run') });
