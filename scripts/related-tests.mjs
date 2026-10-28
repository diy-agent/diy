#!/usr/bin/env node
// scripts/related-tests.mjs — 「改了这个文件，该跑哪些测试」的机器判据（##452）。
//
// 为什么不用 `vitest related`：它要把**每个测试文件的模块图都跑起来**才能算相关性。
// 实测 diy-app（54 个测试文件）上 `vitest related --run <一个文件>` = **92s**，
// 而「全量单测」本身 103s —— 省下的那 10% 还不够启动开销，等于没优化。
// 这里改成**静态 import 图**：只读文件、正则抽 import、沿相对路径 / workspace 包 /
// tsconfig paths 解析，反查「哪些测试（传递地）引用了改动文件」。全部测试 228 个文件
// 一遍扫完 ≈ 200ms（实测），选出后只 `vitest run <选中的文件>`。
//
// 判据（宁多跑、不漏跑）：
//   · 测试自己改了 ⇒ 跑它
//   · 测试的**传递依赖**里命中改动文件 ⇒ 跑它
//   · 传递依赖里有**解析不了的内部 specifier**（动态拼接 / 未登记的别名）⇒ 该测试算受影响
//     （静态分析看不见的边，不能拿「没命中」当「不相关」）
//   · vitest 配置的 setupFiles 改了 ⇒ 该包所有测试算受影响（它们都过 setup）
//   · `tests/**/cli.intent*` 默认不收（真实 Electron 的 E2E，跑法是 `./sha.sh test`；
//     由 `--include-intent` 打开）
//
// 用法：
//   node scripts/related-tests.mjs --files src/a.ts [--dry-run|--json]
//   node scripts/related-tests.mjs                    # 不给 --files ⇒ 用当前 git 改动集
//   node scripts/related-tests.mjs --include-intent   # 连 intent 测试一起选
// 退出码：0 = 跑完了（含「没有测试受影响」）· 非 0 = 有测试失败（原样透传 vitest 的码）
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.DIY_CHECK_SYNC_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const norm = (p) => path.relative(ROOT, path.resolve(ROOT, p)).replace(/\\/g, '/');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
const INCLUDE_INTENT = argv.includes('--include-intent');
const fileArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--files') continue;
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) fileArgs.push(norm(argv[j]));
}

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXT = [...SOURCE_EXT, '/index.ts', '/index.tsx', '/index.mts', '/index.js'];

// ── 工作区包表（名字 → 目录 / exports 映射）──────────────────────────────────
const pkgByName = new Map();
const pkgDirs = [];
if (existsSync(path.join(ROOT, 'pkgs.ts'))) {
  for (const e of readdirSync(path.join(ROOT, 'pkgs.ts'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = `pkgs.ts/${e.name}`;
    const manifestPath = path.join(ROOT, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    pkgDirs.push(dir);
    pkgByName.set(manifest.name, { dir, manifest });
  }
}

// ── tsconfig paths 别名（JSONC：注释先剥再 parse；解析不了就当作没有别名）────
function readJsonc(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const aliases = []; // {prefix, suffix, targets:[绝对路径模板]}
for (const cfg of ['tsconfig.base.json', ...pkgDirs.map((d) => `${d}/tsconfig.json`)]) {
  const paths = readJsonc(path.join(ROOT, cfg))?.compilerOptions?.paths ?? {};
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    const base = path.dirname(path.join(ROOT, cfg));
    aliases.push({
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? '' : pattern.slice(star + 1),
      exact: star < 0,
      targets: targets.map((t) => path.resolve(base, t)),
    });
  }
}

// ESM 习惯写 `./claim.js` 指向 `claim.ts`（TS bundler 模式）—— 先按「换扩展名」试一遍，
// 否则整条依赖链在这里断掉（实测：diy-app 的测试因此全都「不命中」diy-facts 的改动）
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx', '.ts'], '.mjs': ['.mts', '.ts'], '.cjs': ['.cts', '.ts'] };

function tryFile(abs) {
  const mapped = JS_TO_TS[path.extname(abs)];
  if (mapped) {
    for (const ext of mapped) {
      const cand = abs.slice(0, -path.extname(abs).length) + ext;
      if (existsSync(cand) && statSync(cand).isFile()) return { file: cand };
    }
  }
  if (existsSync(abs)) {
    const st = statSync(abs);
    if (st.isFile()) return { file: abs };
    if (st.isDirectory()) return { dir: abs }; // `./fixtures/real` 这类目录入口：按目录算依赖
  }
  for (const ext of RESOLVE_EXT) {
    const cand = abs + ext;
    if (existsSync(cand) && statSync(cand).isFile()) return { file: cand };
  }
  return null;
}

/** 解析一条 specifier；返回 绝对路径（仓内文件）/ null（外部依赖）/ 'UNCERTAIN'（内部但解析不了） */
function resolveSpec(spec, fromAbs) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const hit = tryFile(path.resolve(path.dirname(fromAbs), spec));
    return hit ?? 'UNCERTAIN'; // 相对路径解析不出 = 静态分析看不见 → 保守
  }
  const pkgHit = pkgByName.get(spec) ?? pkgByName.get(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
  if (pkgHit) {
    const sub = spec === pkgHit.manifest.name ? '' : `.${spec.slice(pkgHit.manifest.name.length)}`;
    const exp = pkgHit.manifest.exports?.[sub || '.'];
    const target = typeof exp === 'string' ? exp : (exp?.import ?? exp?.default);
    if (target) {
      const hit = tryFile(path.resolve(ROOT, pkgHit.dir, target));
      if (hit) return hit.file ?? { dir: hit.dir };
    }
    const main = pkgHit.manifest.main ?? pkgHit.manifest.types;
    if (main) {
      const hit = tryFile(path.resolve(ROOT, pkgHit.dir, main));
      if (hit) return hit;
    }
    return 'UNCERTAIN';
  }
  for (const a of aliases) {
    if (a.exact ? spec === a.prefix : spec.startsWith(a.prefix) && spec.endsWith(a.suffix)) {
      const mid = a.exact ? '' : spec.slice(a.prefix.length, spec.length - a.suffix.length);
      for (const t of a.targets) {
        const hit = tryFile(t.replace('*', mid));
        if (hit) return hit;
      }
      return 'UNCERTAIN'; // 命中别名模式但文件不存在 = 可疑，保守
    }
  }
  return null; // 外部依赖（node:fs / zod / solid-js …）
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|importActual[^(]*\(\s*|importMock[^(]*\(\s*)["']([^"']+)["']/g;

function specifiersOf(abs) {
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  // 注释行先丢掉：文档里写一句 `from './x'`（本仓注释极多）不该变成依赖。
  // **不**做「剥块注释」——源码里的 glob 字符串（如 `'src/**/*.ts'`）含 `/*`，
  // 按块注释剥会把它当注释起始、吞掉后面整个文件（实测整条依赖链断在这里）。
  const code = text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  const out = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (/[*{}<>\s]/.test(spec)) continue; // 不是模块 id（通配 / 模板 / 文档占位）
    out.push(spec);
  }
  return out;
}

/** 从一个文件出发的传递依赖集：Map<相对路径, true>；uncertain = 有解析不了的内部 specifier */
/** 依赖集：文件（相对路径）+ 目录（相对路径，以 / 结尾）+ 无法解析的标记 */
function depsOf(entryAbs) {
  const filesSet = new Set();
  const dirs = new Set();
  const uncertainSpecs = new Set();
  const stack = [entryAbs];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    filesSet.add(norm(cur));
    for (const spec of specifiersOf(cur)) {
      const r = resolveSpec(spec, cur);
      if (r === 'UNCERTAIN') uncertainSpecs.add(`${spec} (from ${norm(cur)})`);
      else if (r?.dir) dirs.add(`${norm(r.dir)}/`);
      else if (r?.file && !seen.has(r.file)) stack.push(r.file);
    }
  }
  return { files: filesSet, dirs, uncertain: uncertainSpecs.size > 0, uncertainSpecs };
}

// ── 候选测试文件 ────────────────────────────────────────────────────────────
function walkTests(dirAbs, out = []) {
  if (!existsSync(dirAbs)) return out;
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = path.join(dirAbs, e.name);
    if (e.isDirectory()) walkTests(p, out);
    else if (/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** vitest 配置里的 setupFiles（改了它 = 该包所有测试都受影响） */
function setupFilesOf(pkgDir) {
  const out = [];
  for (const name of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vite.config.ts']) {
    const f = path.join(ROOT, pkgDir, name);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const m = /setupFiles\s*:\s*\[([^\]]*)\]/.exec(text);
    if (!m) continue;
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) {
      const hit = tryFile(path.resolve(ROOT, pkgDir, s[1]));
      if (hit?.file) out.push(hit.file);
    }
  }
  return out;
}

// `--debug-deps <文件>`：打印该文件的传递依赖（排查「为什么这个测试没被选中」）
const debugDeps = argv.indexOf('--debug-deps') >= 0 ? argv[argv.indexOf('--debug-deps') + 1] : null;
if (debugDeps) {
  const abs = path.resolve(ROOT, debugDeps);
  const { files, dirs, uncertainSpecs } = depsOf(abs);
  process.stdout.write(`${[...files].sort().join('\n')}\n`);
  if (dirs.size) process.stdout.write(`\n目录依赖：\n${[...dirs].sort().join('\n')}\n`);
  if (uncertainSpecs.size) process.stdout.write(`\n解析不了：\n${[...uncertainSpecs].sort().join('\n')}\n`);
  process.exit(0);
}

// ── 改动集 ─────────────────────────────────────────────────────────────────
function changedFiles() {
  if (fileArgs.length) return fileArgs;
  const json = execFileSync('node', [path.join(ROOT, 'scripts/changed-plan.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' });
  return JSON.parse(json).files;
}
const changed = new Set(changedFiles().map(norm));
if (changed.size === 0) {
  process.stdout.write('related-tests: 改动集为空 → 没有测试需要跑\n');
  process.exit(0);
}

// ── 选测试 ─────────────────────────────────────────────────────────────────
const perPkg = new Map(); // pkgDir → { files: [], reasons: Map<file, reason>, uncertain: [] }
let parsed = 0;
for (const pkgDir of pkgDirs) {
  const testsDir = path.join(ROOT, pkgDir, 'tests');
  if (!existsSync(testsDir)) continue;
  const testFiles = walkTests(testsDir);
  if (testFiles.length === 0) continue;
  const setups = setupFilesOf(pkgDir).map(norm);
  const setupTouched = setups.some((s) => changed.has(s));
  for (const abs of testFiles) {
    const rel = norm(abs);
    const base = path.relative(path.join(ROOT, pkgDir), abs).replace(/\\/g, '/');
    const isIntent = /(^|\/)cli\.intent[^/]*\.test\.ts$/.test(rel);
    if (isIntent && !INCLUDE_INTENT) continue;
    if (!perPkg.has(pkgDir)) perPkg.set(pkgDir, { files: [], reasons: new Map() });
    const bucket = perPkg.get(pkgDir);
    if (changed.has(rel)) {
      bucket.files.push(base);
      bucket.reasons.set(base, '测试文件自己改了');
      continue;
    }
    if (setupTouched) {
      bucket.files.push(base);
      bucket.reasons.set(base, 'setupFiles 改了');
      continue;
    }
    const { files: deps, dirs, uncertain, uncertainSpecs } = depsOf(abs);
    parsed++;
    const hit = [...changed].filter((c) => deps.has(c) || [...dirs].some((d) => c.startsWith(d)));
    if (hit.length) {
      bucket.files.push(base);
      bucket.reasons.set(base, `依赖命中 ${hit.slice(0, 2).join(', ')}${hit.length > 2 ? ` 等 ${hit.length} 个` : ''}`);
    } else if (uncertain) {
      bucket.files.push(base);
      bucket.reasons.set(base, `解析不了的 specifier：${[...uncertainSpecs].slice(0, 2).join(' / ')}`);
    }
  }
}

const plan = [];
for (const [pkgDir, v] of perPkg) if (v.files.length) plan.push({ pkg: pkgDir, files: v.files.sort(), reasons: Object.fromEntries(v.reasons) });
plan.sort((a, b) => a.pkg.localeCompare(b.pkg));
const totalFiles = plan.reduce((n, p) => n + p.files.length, 0);

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ changed: [...changed].sort(), scanned: parsed, totalFiles, plan }, null, 2)}\n`);
  process.exit(0);
}

if (DRY) {
  process.stdout.write(`改动 ${changed.size} 个文件 · 扫了 ${parsed} 个测试文件的依赖图\n`);
  if (!plan.length) process.stdout.write('→ 没有测试受影响\n');
  for (const p of plan) {
    process.stdout.write(`▶ ${p.pkg}（${p.files.length} 个）\n`);
    for (const f of p.files) process.stdout.write(`    ${f}  — ${p.reasons[f]}\n`);
  }
  process.exit(0);
}

if (!plan.length) {
  process.stdout.write(`没有测试受影响（改动 ${changed.size} 个文件，扫了 ${parsed} 个测试的依赖图）\n`);
  process.exit(0);
}

process.stdout.write(`受影响测试 ${totalFiles} 个文件 / ${plan.length} 个包（扫了 ${parsed} 个测试的依赖图）\n`);
let worst = 0;
for (const p of plan) {
  process.stdout.write(`\n▶ ${p.pkg}：vitest run ${p.files.length} 个文件\n`);
  const r = spawnSync('npx', ['vitest', 'run', ...p.files], { cwd: path.join(ROOT, p.pkg), stdio: 'inherit' });
  if (r.status !== 0 && !worst) worst = r.status ?? 1;
}
process.exit(worst);
