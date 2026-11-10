#!/usr/bin/env node
// scripts/npm-publish.mjs — 把「仓内源码形态」的包组装成「发行形态」并发布到 npm。
//
// 为什么不直接 `npm publish`：仓内 package.json 的 `main`/`exports` 指 `src/*.ts`
// （workspace 内部由 vite 直接吃源码，见 apps/diy-app/vite.pkg-deps.ts 的
// WORKSPACE_TS_DEPS），且带 `private: true` 当防手滑护栏。发行物必须换一份
// package.json：`exports` 指 `lib/*.js` + `*.d.ts`，去掉 `private`，`*` 依赖改成 `^<仓内版本>`。
//
// 流程（两步都走本脚本）：
//   --prepare-only  在 <pkg>/lib/ 生成发行版 package.json（不含 private）
//   默认            先生成，再 `npm publish <pkg>/lib`
//
// 用法：node scripts/npm-publish.mjs <pkgDir> [--prepare-only] [--dry-run] [--out=dist]
//
// 约定（脚本假设，见各包 tsconfig.build.json）：
//   * `tsc -p tsconfig.build.json` 的 rootDir = src、outDir = dist（2026-11-06 统一，见 fcf81e24
//     「各包产物 lib/ → dist/」；更早是 lib）⇒ 产物目录与 src/ 同构，`./src/a/b.ts` 对应 `./a/b.js`。
//   * 产物目录用 `--out=<dir>` 指定（缺省 dist）。⚠️ 各包 sha.sh 的 `--out=` 必须与
//     tsconfig.build.json 的 outDir 一致 —— 一端 lib 一端 dist 就是「✗ lib 不存在」的假错（##522）。
//
// 认证 / registry / 内部依赖版本都在 ./npm-publish-common.mjs（与 app 发布共用一份）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publishDir, releaseManifest, workspacePackages } from './npm-publish-common.mjs';
import { REPO_ROOT } from './workspace-dirs.mjs';

const args = process.argv.slice(2);
const outFlag = args.find((a) => a.startsWith('--out='));
const outName = outFlag ? outFlag.slice('--out='.length) : 'dist';
const flags = new Set(args.filter((a) => a.startsWith('-')));
const pkgDirArg = args.find((a) => !a.startsWith('-'));
if (!pkgDirArg) {
    console.error('用法: node scripts/npm-publish.mjs <pkgDir> [--prepare-only] [--dry-run] [--out=<dir>]');
    process.exit(2);
}

const pkgDir = path.resolve(pkgDirArg);
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const distDir = path.join(pkgDir, outName);

if (!existsSync(distDir)) {
    console.error(`✗ ${path.relative(process.cwd(), distDir)} 不存在 —— 先 build（./sha.sh build）`);
    process.exit(1);
}

/** `./src/index.ts`（或 `./dist/index.js`、老包的 `./lib/index.js`）→ `./index.js`；目录型条目同样成立 */
const toDistPath = (spec, ext) => {
    const rel = spec.replace(/^\.\//, '');
    const m = rel.match(/^(?:src|dist|lib)\/(.+)$/);
    if (!m) {
        throw new Error(`exports 条目不在 src/、dist/ 或 lib/ 下，无法推导产物路径：${spec}`);
    }
    return `./${m[1].replace(/\.(ts|js)$/, ext)}`;
};

if (!pkg.exports || typeof pkg.exports !== 'object') {
    console.error('✗ 仓内 package.json 缺 exports（发行映射的唯一依据）');
    process.exit(1);
}

const distExports = {};
for (const [key, value] of Object.entries(pkg.exports)) {
    // 兼容两种仓内形态：老的字符串形式（`./src/index.ts`）与新的条件对象（`{types, default}`）
    const spec = typeof value === 'string' ? value : value?.default;
    if (typeof spec !== 'string') {
        throw new Error(`exports["${key}"] 取不到出口路径（当前：${JSON.stringify(value)}）`);
    }
    distExports[key] = {
        types: toDistPath(spec, '.d.ts'),
        import: toDistPath(spec, '.js'),
        default: toDistPath(spec, '.js'),
    };
}

// 仓根**不能**用 `path.resolve(pkgDir, '../..')` 推：##512 把包布局改成 pkgs.ts/<组>/<包>（两层）后，
// 那个表达式对 pkgs.ts/agent/session 得到的是 pkgs.ts —— 于是 versions 为空，任何 `@diy-agent/*`
// 依赖都报「在仓内找不到对应 workspace 包」（2026-11-10 发布就倒在这里）。用唯一口径 REPO_ROOT。
const versions = workspacePackages(REPO_ROOT);
const out = releaseManifest(pkg, versions);
const rootEntry = distExports['.'];
out.main = rootEntry.default;
out.types = rootEntry.types;
out.exports = distExports;

const outFile = path.join(distDir, 'package.json');
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(`✓ 生成发行版 package.json: ${path.relative(process.cwd(), outFile)}`);
console.log(`  name=${out.name}@${out.version} exports=[${Object.keys(distExports).join(', ')}]`);

if (flags.has('--prepare-only')) process.exit(0);
publishDir(distDir, { dryRun: flags.has('--dry-run') });
