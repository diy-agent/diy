#!/usr/bin/env node
// scripts/npm-publish.mjs — 把「仓内源码形态」的包组装成「发行形态」并发布到 npm。
//
// 为什么不直接 `npm publish`：仓内 package.json 的 `main`/`exports` 指 `src/*.ts`
// （workspace 内部由 vite 直接吃源码，见 pkgs.ts/diy-app/vite.pkg-deps.ts 的
// WORKSPACE_TS_DEPS），且带 `private: true` 当防手滑护栏。发行物必须换一份
// package.json：`exports` 指 `dist/*.js` + `*.d.ts`，去掉 `private`。
//
// 流程（两步都走本脚本）：
//   --prepare-only  在 <pkg>/dist/ 生成发行版 package.json（不含 private）
//   默认            先生成，再 `npm publish <pkg>/dist`
//
// 用法：node scripts/npm-publish.mjs <pkgDir> [--prepare-only] [--dry-run]
//
// 约定（脚本假设，见各包 tsconfig.build.json）：
//   * `tsc -p tsconfig.build.json` 的 rootDir = src、outDir = lib（缺省；老包曾是 dist）
//     ⇒ 产物目录与 src/ 同构，`./src/a/b.ts` 对应 `./a/b.js`。
//   * 产物目录用 `--out=<dir>` 指定（缺省 dist，与历史行为一致）；内部包统一 lib。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 从仓内 package.json 原样带过去的字段 */
const PASSTHROUGH = [
  'name',
  'version',
  'description',
  'keywords',
  'license',
  'repository',
  'homepage',
  'bugs',
  'author',
  'type',
  'engines',
  'sideEffects',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];

/** 发布目标：官方 registry（本机 ~/.npmrc 常指淘宝镜像，必须显式覆盖） */
const REGISTRY = 'https://registry.npmjs.org/';

const args = process.argv.slice(2);
const outFlag = args.find((a) => a.startsWith('--out='));
const outName = outFlag ? outFlag.slice('--out='.length) : 'dist';
const flags = new Set(args.filter((a) => a.startsWith('-')));
const pkgDirArg = args.find((a) => !a.startsWith('-'));
if (!pkgDirArg) {
  console.error('用法: node scripts/npm-publish.mjs <pkgDir> [--prepare-only] [--dry-run]');
  process.exit(2);
}

const pkgDir = path.resolve(pkgDirArg);
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const distDir = path.join(pkgDir, outName);

if (!existsSync(distDir)) {
  console.error(`✗ ${path.relative(process.cwd(), distDir)} 不存在 —— 先 build（./sha.sh build）`);
  process.exit(1);
}

/** `./src/index.ts`（或 `./lib/index.js`）→ `./index.js`；目录型条目同样成立 */
const toDistPath = (spec, ext) => {
  const rel = spec.replace(/^\.\//, '');
  const m = rel.match(/^(?:src|lib)\/(.+)$/);
  if (!m) {
    throw new Error(`exports 条目不在 src/ 或 lib/ 下，无法推导产物路径：${spec}`);
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

const rootEntry = distExports['.'];
const out = { name: pkg.name, version: pkg.version };
if (pkg.private === true) {
  console.log('  · 仓内 private:true 已剥离（发行物必须可发布）');
}
for (const key of PASSTHROUGH) {
  if (key === 'name' || key === 'version') continue;
  if (pkg[key] !== undefined) out[key] = pkg[key];
}
out.type = pkg.type ?? 'module';
out.main = rootEntry.default;
out.types = rootEntry.types;
out.exports = distExports;
out.publishConfig = { registry: REGISTRY, access: 'public' };

const outFile = path.join(distDir, 'package.json');
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(`✓ 生成发行版 package.json: ${path.relative(process.cwd(), outFile)}`);
console.log(`  name=${out.name}@${out.version} exports=[${Object.keys(distExports).join(', ')}]`);

if (flags.has('--prepare-only')) process.exit(0);

/**
 * 取发布 token：优先环境变量；非交互 shell 不读 ~/.bashrc，故回落到那里
 * （本机约定 token 存 `~/.bashrc` 的 `export NPM_PUBLISH_TOKEN="npm_…"`）。
 */
const resolveToken = () => {
  if (process.env.NPM_PUBLISH_TOKEN) return process.env.NPM_PUBLISH_TOKEN;
  const rc = path.join(os.homedir(), '.bashrc');
  if (!existsSync(rc)) return undefined;
  const m = readFileSync(rc, 'utf8').match(/^\s*export\s+NPM_PUBLISH_TOKEN=["']?([^"'\s]+)["']?\s*$/m);
  return m?.[1];
};

const token = resolveToken();
if (!token) {
  console.error('✗ 未找到 NPM_PUBLISH_TOKEN（环境变量或 ~/.bashrc 的 export NPM_PUBLISH_TOKEN="npm_…"）');
  process.exit(1);
}
process.env.NPM_PUBLISH_TOKEN = token;

// 临时 userconfig：① 绕开 ~/.npmrc 里的淘宝镜像 ② token 用 ${VAR} 引用，**不落明文**
const cfgDir = mkdtempSync(path.join(os.tmpdir(), 'diy-npm-publish-'));
const userconfig = path.join(cfgDir, '.npmrc');
writeFileSync(
  userconfig,
  `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=\${NPM_PUBLISH_TOKEN}\n`,
);

try {
  const publishArgs = ['publish', '--userconfig', userconfig, '--workspaces=false', '--access', 'public'];
  if (flags.has('--dry-run')) publishArgs.push('--dry-run');
  console.log(`▶ npm publish（cwd=${path.relative(process.cwd(), distDir)}，registry=${REGISTRY}）`);
  execFileSync('npm', publishArgs, { cwd: distDir, stdio: 'inherit' });
  console.log(`✓ ${out.name}@${out.version} 发布完成`);
} finally {
  rmSync(cfgDir, { recursive: true, force: true });
}
