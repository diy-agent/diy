#!/usr/bin/env node
// scripts/changed-plan.mjs — 「这次改动影响了什么」的机器判据（##452）。
//
// 用途：给 `./sha.sh check --changed` / `./sha.sh test --related` 算**受影响集**
// （受影响的包 / tsconfig 项目 / lint 路径 / 该跑哪些护栏脚本），不含任何「抽样」：
// 先算全集再裁剪，**算不准的一律退回全量**（`full: true`）。
//
// 受苦点（##452 实测）：`./sha.sh check` 全量 45s、`vitest run tests/core/` 108s，
// agent「保险起见跑全量」⇒ 一轮 3 次 check = 几分钟纯等待。
//
// 改动的来源（四项取并集，缺一都会漏报）：
//   ① 已提交：`git diff --name-only <merge-base(base,HEAD)>..HEAD`
//   ② 已暂存：`git diff --name-only --cached`
//   ③ 未暂存：`git diff --name-only`
//   ④ 未跟踪：`git ls-files --others --exclude-standard`
// 为什么 ① 用 merge-base 而不是直接比 base：本人分支与 base 并行提交时，直接比会把
// **别人**的改动算进来（只会多跑，不会漏跑，但时延目标就没了）；三点比较才是「我改了什么」。
//
// 用法：
//   node scripts/changed-plan.mjs                 # 人读报告
//   node scripts/changed-plan.mjs --json          # 机器读（sha.sh 消费）
//   node scripts/changed-plan.mjs --base main     # 换比较基线（缺省 origin/main → main → HEAD~1）
//   node scripts/changed-plan.mjs --files a b c   # 直接给受影响文件（test --related 用；
//                                                 #   相对仓根、可带绝对路径）
//   node scripts/changed-plan.mjs --sh            # 输出 shell 片段（sha.sh 消费）
//   node scripts/changed-plan.mjs --explain       # 每项判据为什么这么定（人读）
//
// 判据（收窄的只有「跑不跑」，不是「查得严不严」）：
//   · 类型检查**不收窄**：`tsc -b` 自己就是增量的（.tsbuildinfo 命中即跳过该 project），
//     实测「改一个包内文件后全图 tsc -b」= 1.9s、「只跑受影响包 + 反向闭包」= 1.6~4.6s
//     —— 收窄没有收益，反而要自己维护反向闭包（漏一个依赖方就漏报）⇒ 全图跑，
//     把「只跑该跑的」交给 TS 自己。收窄的是 lint（逐文件判据）与护栏（各有扫描根）。
//   · lint：受影响包的目录（oxlint 是逐文件判，不看别的文件）
//   · 护栏脚本：按各自的**扫描根**与改动集是否相交决定（每条都有 why，见 --explain）
//   · 认不出的改动（根配置 / 构建脚本 / sha.sh 自身）⇒ full = true，退回全量
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.DIY_CHECK_SYNC_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const SH_OUT = argv.includes('--sh');
const EXPLAIN = argv.includes('--explain');
// `--class`：只回答「这轮跑多大面」（见下 classOf），**不算包图 / 不算护栏**。
// sha.sh 靠它早退（改动不含 pkgs.ts/** ⇒ 直接全量，不必白算一遍 plan）。
const CLASS_ONLY = argv.includes('--class');

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function argList(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  }
  return out;
}

const norm = (p) => p.replace(/\\/g, '/');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

function lines(s) {
  return s.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 比较基线：显式 --base > 环境变量 > origin/main > main > HEAD~1（都不在则空集） */
function resolveBase(explicit) {
  const candidates = [explicit ?? process.env.DIY_CHECK_BASE, 'origin/main', 'main', 'HEAD~1'].filter(Boolean);
  for (const ref of candidates) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const baseRef = resolveBase(argValue('--base'));
const explicitFiles = argList('--files');

// ── 变动集 ───────────────────────────────────────────────────────────────────
const files = new Set(explicitFiles.map(norm));
const untracked = new Set();
const source = { committed: [], staged: [], unstaged: [], untracked: [] };

if (explicitFiles.length === 0) {
  if (baseRef) {
    let mergeBase = '';
    try {
      mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
    } catch {
      mergeBase = '';
    }
    if (mergeBase) {
      if (CLASS_ONLY) {
        // 快路径（只给 `--class` 用）：`git diff <mb>` 已经把**已提交 + 已暂存 + 未暂存**
        // 一次问清（工作树 vs merge-base），再加未跟踪文件 —— 3 次 git 调用而不是 5 次。
        source.committed = lines(git(['diff', '--name-only', mergeBase]));
        source.untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
      } else {
        source.committed = lines(git(['diff', '--name-only', mergeBase, 'HEAD']));
        source.staged = lines(git(['diff', '--name-only', '--cached']));
        source.unstaged = lines(git(['diff', '--name-only']));
        source.untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
      }
    }
  }
  for (const k of Object.keys(source)) for (const f of source[k]) files.add(norm(f));
  for (const f of source.untracked) untracked.add(norm(f));
}
const fileList = [...files].sort();

// ── 先定「这轮跑多大面」（= `--class`，**只靠文件路径、不算包图/护栏**，给 sha.sh 早退用）──
// 为什么单独有这一步（##452 Review ①）：干净 worktree 里 `check --changed` 曾比全量还慢 2s ——
// 白花了算 plan 的钱。三类之外的改动不用细算：直接全量 / 直接最小面。
//
//   none   没有改动
//   data   **纯数据**改动（knowledge/ · docs/ · *.md · gen/）⇒ 连 tsc / oxlint 都不用跑
//   full   ① 碰了根配置 / 脚本（tsconfig / lock / scripts/** / sha.sh / vitest.config …）
//          ② **不含 pkgs.ts/** ⇒ 按包收敛无从谈起（改的是根目录的东西）
//          两者都直接走全量：宁可慢一次，不许按错的维度裁剪
//   narrow 只碰 pkgs.ts/**（+ 可能的纯数据文件）⇒ 才算 plan、按包裁剪
const FULL_RE =
  /^(tsconfig[^/]*\.json|package\.json|package-lock\.json|vitest\.config\.[cm]?[jt]s|sha\.sh|sha\.common\.sh|\.oxlintrc[^/]*|oxfmt\.json|diy\.yaml)$/;
// 「纯数据」= 改了它不可能让类型 / lint 有变化：文档、知识库事实、任务产物
const DATA_RE = /^(knowledge\/|docs\/|gen\/)|(^|\/)[^/]*\.md$/;

// 「中性」= 既不影响类型/lint，也不算「根级配置」：vendor 下的子模块 / 镜像代码由
// 各自的仓管（`vendor/sha` 是 submodule），本仓的检查一枚都不读它。
const NEUTRAL_RE = /^vendor\//;

const fullReasons = fileList.filter((f) => !NEUTRAL_RE.test(f) && (FULL_RE.test(f) || f.startsWith('scripts/')));

// **顺序即判据**（Review 第 2 轮：曾经把「不含 pkgs.ts/** ⇒ full」放在 data 前面，
// 于是 data 分支永远走不到）：
//   ① 全空 ⇒ none
//   ② **全部是纯数据 ⇒ data**（必须最先判 —— 它是「跳过 tsc」的唯一入口）
//   ③ 碰了根级配置 / 脚本 ⇒ full
//   ④ 不含 pkgs.ts/** ⇒ full（按包收敛无从谈起）
//   ⑤ 其余 ⇒ narrow
const classOf = (list) => {
  const effective = list.filter((f) => !NEUTRAL_RE.test(f));
  if (effective.length === 0) return list.length === 0 ? 'none' : 'data'; // 只有 vendor/** ⇒ 当作数据级
  if (effective.every((f) => DATA_RE.test(f))) return 'data';
  if (fullReasons.length > 0) return 'full';
  if (!effective.some((f) => f.startsWith('pkgs.ts/'))) return 'full';
  return 'narrow';
};
const mode = classOf(fileList);

if (CLASS_ONLY) {
  process.stdout.write(`${mode}\n`);
  process.exit(0);
}

// 删除了哪些文件：**引用完整性**类的护栏（facts G4 证据可解析 / specs G2 指针可解析 /
// atomic-write 白名单「列的文件必须存在」）会因「删了被引用的文件」而红，与改动落在哪个
// 包无关 ⇒ 有删除就跑它们。只查删除，代价是 3 次 `--diff-filter=D`。
const deleted = new Set();
if (explicitFiles.length === 0 && !CLASS_ONLY) {
  const del = (args) => {
    try {
      for (const f of lines(git(['diff', '--name-only', '--diff-filter=D', ...args]))) deleted.add(norm(f));
    } catch {
      /* 没有基线 / 仓库异常：不记删除，后续按路径判（保守） */
    }
  };
  del([]);
  del(['--cached']);
  if (baseRef) del([`${git(['merge-base', baseRef, 'HEAD']).trim()}`, 'HEAD']);
}
const deletedList = [...deleted].sort();

// ── 包图（pkgs.ts/*）────────────────────────────────────────────────────────
const PKGS_DIR = 'pkgs.ts';
const pkgDirs = existsSync(path.join(ROOT, PKGS_DIR))
  ? readdirSync(path.join(ROOT, PKGS_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(ROOT, PKGS_DIR, e.name, 'package.json')))
      .map((e) => `${PKGS_DIR}/${e.name}`)
      .sort()
  : [];

const pkgName = new Map(); // dir → name
const pkgByDir = new Map(); // dir → manifest
for (const dir of pkgDirs) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  pkgByDir.set(dir, manifest);
  pkgName.set(dir, manifest.name);
}
const dirByName = new Map([...pkgName].map(([dir, name]) => [name, dir]));

const dependents = new Map(pkgDirs.map((d) => [d, new Set()]));
for (const [dir, manifest] of pkgByDir) {
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
  for (const dep of deps) {
    const d = dirByName.get(dep);
    if (d && d !== dir) dependents.get(d)?.add(dir);
  }
}

/** 文件 → 所属包（`pkgs.ts/<x>/…` 取第一段；根文件返回 null） */
function ownerOf(file) {
  const m = /^pkgs\.ts\/([^/]+)\//.exec(file);
  if (!m) return null;
  const dir = `${PKGS_DIR}/${m[1]}`;
  return pkgByDir.has(dir) ? dir : null;
}

const directPackages = new Set();
for (const f of fileList) {
  const o = ownerOf(f);
  if (o) directPackages.add(o);
}

/** 反向闭包：受影响包 + 依赖它的包（一层层往上） */
const affectedPackages = new Set(directPackages);
const queue = [...directPackages];
while (queue.length) {
  const cur = queue.pop();
  for (const up of dependents.get(cur) ?? []) {
    if (!affectedPackages.has(up)) {
      affectedPackages.add(up);
      queue.push(up);
    }
  }
}


// ── 认不出的改动 ⇒ 全量 ─────────────────────────────────────────────────────
// 这些路径改了，影响面**不按包收敛**：根 tsconfig 动的是全仓编译选项、lock 动的是装包、
// scripts/ 动的是护栏自己、sha.sh 动的是入口。认不出就全跑 —— 宁可慢一次，不许漏。

// ── 改动里「新增的代码行」，按文件分组（护栏按内容判，比按路径判准）─────────────
// 为什么按文件分组：护栏各有扫描根，拿「全仓新增行」判会自己吓自己 —— 本脚本的注释里
// 写着一行 `throw new`，就足以让 error-code 恒跑。
// 未跟踪文件 = 全文都算新增（新文件里的每一行都是这次加的）。
const addedByFile = new Map();
function collectAdded() {
  if (explicitFiles.length) return; // 给的是文件清单，没有 diff 可读 ⇒ 交回按路径判（保守）
  const eat = (diffText) => {
    let cur = null;
    for (const line of diffText.split('\n')) {
      if (line.startsWith('+++ ')) {
        const p = norm(line.slice(4).replace(/^b\//, ''));
        cur = p === '/dev/null' ? null : p;
        if (cur) addedByFile.set(cur, addedByFile.get(cur) ?? '');
        continue;
      }
      if (!cur || !line.startsWith('+')) continue;
      addedByFile.set(cur, `${addedByFile.get(cur)}\n${line.slice(1)}`);
    }
  };
  const runs = [];
  if (baseRef) {
    try {
      const mb = git(['merge-base', baseRef, 'HEAD']).trim();
      runs.push(git(['diff', '-U0', mb, 'HEAD'], { maxBuffer: 64 << 20 }));
    } catch {
      /* 没有基线就不看已提交部分 */
    }
  }
  runs.push(git(['diff', '-U0'], { maxBuffer: 64 << 20 }));
  runs.push(git(['diff', '-U0', '--cached'], { maxBuffer: 64 << 20 }));
  for (const d of runs) eat(d);
  for (const f of untracked) {
    try {
      addedByFile.set(f, readFileSync(path.join(ROOT, f), 'utf8'));
    } catch {
      /* 二进制 / 读不到就跳过：对应护栏按路径判会兜住 */
    }
  }
}
collectAdded();

/** 改动里是否有「按某护栏的扫描根新增的代码行」命中 re */
function addedMatches(paths, re) {
  for (const f of paths) {
    const text = addedByFile.get(f);
    if (text && text.split('\n').some((l) => re.test(l))) return true;
  }
  return false;
}

// ── 各护栏的「跑不跑」──────────────────────────────────────────────────────
// 每条：扫描根（见各脚本头注）+ 判据。**默认跑**，只有明确不相交才跳过。
const guards = [];

// 产物护栏**不过滤**：它扫的是文件系统（误 emit 的 .js 常被 .gitignore 吞掉，
// 按 git 改动集判会漏 —— 实测 `pkgs.ts/*/src/x.js` 被忽略时 --changed 绿、全量红）。
// 而它本身只要 0.13s（一次 find），常驻比「算得准」便宜。
guards.push({
  id: 'no-emit',
  script: 'bash scripts/check-no-emit.sh',
  run: true,
  why: '扫文件系统里的包源码目录（0.13s；按 git 改动集判会漏被 .gitignore 吞掉的误 emit）',
});

// 判据按**内容**：索引里丢了可执行位的是「首行 shebang 是 shell」的文件，
// 而这类文件不一定叫 `.sh`（`pkgs.ts/diy-dev/bin/dev`、`bin/diy`）。
const shTouched = fileList.filter((f) => {
  if (f.endsWith('.sh')) return true;
  if (untracked.has(f)) return true; // 新增文件一律看一眼（新脚本 = 最容易丢位）
  try {
    return readFileSync(path.join(ROOT, f), 'utf8').slice(0, 200).split('\n')[0].startsWith('#!');
  } catch {
    return false; // 已删除 / 二进制
  }
});
guards.push({
  id: 'exec-bit',
  script: 'bash scripts/check-exec-bit.sh',
  run: shTouched.length > 0,
  why: shTouched.length
    ? `改动集里有 shell 脚本 / 新文件（${shTouched.slice(0, 3).join(', ')}）`
    : '没碰任何 shell 脚本（可执行位只在新增/改脚本时会丢）',
});

const nodeSrc = /^pkgs\.ts\/diy-app\/src\/(main|serve|preload)\//;
const nodeSrcTouched = fileList.filter((f) => nodeSrc.test(f));
guards.push({
  id: 'atomic-write',
  script: 'bash scripts/check-atomic-write.sh',
  run: nodeSrcTouched.length > 0 || deletedList.length > 0,
  why: nodeSrcTouched.length
    ? `${nodeSrcTouched.length} 个 Node 侧源文件改动`
    : deletedList.length
      ? `有 ${deletedList.length} 个文件被删（白名单里的文件必须存在）`
      : '没碰 Node 侧（src/{main,serve,preload}）源文件、也没删文件',
});

const appTests = fileList.filter((f) => f.startsWith('pkgs.ts/diy-app/tests/'));
guards.push({
  id: 'no-vi-mock',
  script: 'bash scripts/check-no-vi-mock.sh',
  run: appTests.length > 0,
  why: appTests.length ? `${appTests.length} 个 diy-app 测试文件改动` : '没碰 pkgs.ts/diy-app/tests',
});

// 异常码：扫描根 = pkgs.ts/diy-app/src；只看**该扫描根下**新增的 `throw new`
// （删/改不会让存量基线变差，故不必跑）
const ecRoot = fileList.filter((f) => /^pkgs\.ts\/diy-app\/src\//.test(f));
const throwsNew = addedMatches(ecRoot, /\bthrow new\b/);
guards.push({
  id: 'error-code',
  script: 'bash scripts/check-error-code.sh',
  run: throwsNew,
  why: throwsNew ? 'pkgs.ts/diy-app/src 下有新增的 `throw new`' : 'pkgs.ts/diy-app/src 下没有新增的 `throw new`（删/改不会让基线变差）',
});

const manifestTouched = fileList.filter((f) => f.endsWith('package.json'));
guards.push({
  id: 'pkg-visibility',
  script: 'node scripts/check-pkg-visibility.mjs',
  run: manifestTouched.length > 0,
  why: manifestTouched.length ? `${manifestTouched.length} 个 package.json 改动` : '没改 package.json',
});

// runtime 依赖闭包：扫的是 runtime/ 产物目录（不进 git），与 git 改动集基本无关；
// 未生成时脚本自己跳过，故常驻跑（一次 readdir，可忽略）。
guards.push({
  id: 'runtime-closure',
  script: 'node scripts/check-runtime-closure.mjs',
  run: true,
  why: '扫 runtime/ 的 @diy-agent 依赖闭包（未生成时自动跳过）',
});

const syncIo = fileList.filter((f) => /^pkgs\.ts\/diy-app\/src\/(main|shared|preload)\//.test(f));
guards.push({
  id: 'sync-io',
  script: 'bash scripts/check-sync-io.sh',
  run: syncIo.length > 0,
  why: syncIo.length ? `${syncIo.length} 个 src/{main,shared,preload} 文件改动` : '没碰 src/{main,shared,preload}',
});

const specs = fileList.filter((f) => /(^|\/)AGENTS\.md$/.test(f) || f === 'scripts/specs-unindexed.txt');
guards.push({
  id: 'specs',
  script: 'npx tsx scripts/check-specs.mts',
  run: specs.length > 0 || deletedList.length > 0,
  why: specs.length
    ? `${specs.length} 个 AGENTS.md / 基线文件改动`
    : deletedList.length
      ? `有 ${deletedList.length} 个文件被删（总表的指针可能悬空）`
      : '没碰任何 AGENTS.md、也没删文件（它是按链扫的）',
});

const facts = fileList.filter((f) => f.startsWith('knowledge/'));
guards.push({
  id: 'facts',
  script: 'npx tsx scripts/facts-index.mts',
  run: facts.length > 0 || deletedList.length > 0,
  why: facts.length
    ? `${facts.length} 个知识库文件改动`
    : deletedList.length
      ? `有 ${deletedList.length} 个文件被删（证据指针可能悬空）`
      : '没碰 knowledge/、也没删文件（事实库真源）',
});

const full = mode === 'full';
const plan = {
  base: baseRef,
  mode,
  full,
  fullReasons,
  files: fileList,
  untracked: [...untracked].sort(),
  directPackages: [...directPackages].sort(),
  affectedPackages: [...affectedPackages].sort(),
  lintPaths: [...new Set([...directPackages, ...affectedPackages])].sort(),
  browserTsc: affectedPackages.has('pkgs.ts/diy-rpc'),
  guards,
};

if (SH_OUT) {
  // shell 片段：sha.sh 里 `eval "$(node scripts/changed-plan.mjs --sh ...)"` 直接吃
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const arr = (name, items) => `${name}=(${items.map(q).join(' ')})`;
  const out = [];
  out.push(`plan_mode=${q(plan.mode)}`);
  out.push(`plan_full=${plan.full ? 1 : 0}`);
  out.push(`plan_base=${q(plan.base ?? '')}`);
  out.push(`plan_full_reasons=${q(plan.fullReasons.join(', '))}`);
  out.push(`plan_browser=${plan.browserTsc ? 1 : 0}`);
  out.push(arr('plan_files', plan.files));
  out.push(arr('plan_affected', plan.affectedPackages));
  out.push(arr('plan_lint', plan.lintPaths));
  out.push(arr('plan_guard_cmds', plan.guards.filter((g) => g.run).map((g) => g.script)));
  out.push(arr('plan_skip', plan.guards.filter((g) => !g.run).map((g) => `${g.id}: ${g.why}`)));
  out.push(`plan_summary=${q(`${plan.files.length} 个文件 · 受影响包 ${plan.affectedPackages.join(' ') || '(无)'}`)}`);
  process.stdout.write(`${out.join('\n')}\n`);
} else if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else {
  const out = [];
  out.push(`基线 ${plan.base ?? '(无)'} · 改动 ${plan.files.length} 个文件 · 面=${plan.mode}${plan.full ? '（全量）' : ''}`);
  if (plan.full) out.push(`  全量原因：${plan.fullReasons.join(', ')}`);
  out.push(`受影响包：${plan.affectedPackages.join(', ') || '(无)'}`);
  for (const g of plan.guards) out.push(`  ${g.run ? '▶' : '·'} ${g.id.padEnd(14)} ${g.why}`);
  if (EXPLAIN) out.push('', '（▶ 跑 / · 跳过；判据见 scripts/changed-plan.mjs 头注）');
  process.stdout.write(`${out.join('\n')}\n`);
}
