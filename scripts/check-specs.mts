#!/usr/bin/env node
// scripts/check-specs.mts — 各领域规范索引总表 `~/SPECS.md` 的查重护栏（##388）。
//
// 为什么需要它：各层 AGENTS.md 里的跨领域规范（UI / 日志 / 环境感知 / 错误 …）要**集体
// review**，却散在链文件 + 任务 body 里，光靠人记不出「这条是不是已经有了」。本脚本用机器
// 保证**不重复**：
//   G1 key 全链唯一      —— 总表里同一个中文 key 出现两次 = error
//   G2 指针可解析        —— 每条的真源（文件 + 英文 key，或任务 + 锚文本）必须真在那儿 = error
//   G3 新增未收录        —— 链上有、表里没有、且**不在基线**的 key = warning（ratchet）
//
// G3 为什么是 ratchet（基线增量）而不是「全录」：链上 160+ 条 key，一次录满不现实，而报
// 「未收录 N/全部」会让 warning 常驻 —— 人看两次就学会无视它，连 G1/G2 的真 error 一起被
// 无视（warning 疲劳 >= 没有 warning）。故：
//   · `scripts/specs-unindexed.txt`  = **存量基线**（一行一个 key，进 git）：存量欠账不响；
//   · G3 只报 `missing − baseline` = **真·新增遗漏**（防「忘」）；
//   · `--update-baseline` 把当前 missing 写进基线（批量补录后刷新一次）。
//
// **G3 扫描范围（一句话）**：`~/AGENTS.md` → `~/git/AGENTS.md` → `~/git/diy/AGENTS.md` → 仓根
// `AGENTS.md` → `pkgs.ts/diy-app/AGENTS.md`，共 5 份；**不含** `pkgs.ts/` 其余各包（包内是
// 包局部事实，不是跨领域规范 —— 扫进来只会制造常驻噪声，review1 裁决）。
//
// 前缀白名单**只收跨领域规范**：`find.*`（去哪找）/ `pit.*`（坑）是**导航**不是规范，不收
// —— 拿它们算「未收录」是拿错了尺子（review1 R1）。
//
// 总表**只做索引**，正文仍住各层 AGENTS.md —— 分层加载是刚需（cwd 决定加载哪些、读链即得
// 全文），总表是给人 review 的视图。故 G2 是**硬**的：指针悬空 = 索引在撒谎。
//
// 总表缺失（跨机器 / CI 没有家目录那份文件）⇒ 打印跳过提示、退出 0，不算失败。
//
// 用法：
//   npx tsx scripts/check-specs.mts                    默认查 ~/SPECS.md
//   npx tsx scripts/check-specs.mts <specs.md>         指定总表（可测性 / 演练）
//   npx tsx scripts/check-specs.mts --update-baseline  把当前 missing 写进 scripts/specs-unindexed.txt
//   DIY_SPECS=<path> 同效
//
// 退出码：0 = 通过（含「总表缺失跳过」）· 1 = 有 error
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DIY_HOME = process.env.DIY_HOME ?? path.join(HOME, '.diy');

const argv = process.argv.slice(2);
const UPDATE_BASELINE = argv.includes('--update-baseline');
const positional = argv.filter((a) => !a.startsWith('--'));

// 总表位置：家目录（与 ~/AGENTS.md 并列，跨项目 —— 索引对象本身跨项目）
const SPECS = path.resolve(positional[0] ?? process.env.DIY_SPECS ?? path.join(HOME, 'SPECS.md'));
// 存量基线：与本脚本同处 scripts/，进 git（机制的一部分，不是数据）
const BASELINE = path.join(ROOT, 'scripts', 'specs-unindexed.txt');

// G3 的 key 前缀白名单：**只收跨领域规范**（按实测收口，2026-10-19 扫链）。
// `find` / `pit` 是「包内去哪找 / 包内什么坑」= 导航，不是规范，故意不收。
// 白名单外的前缀不静默吞掉 —— 见到就提示「是否该加进来」，否则新领域永远看不见。
const PREFIXES = ['rule', 'tool', 'proj', 'data', 'dev', 'entry', 'model', 'env', 'level', 'ref'];
// 明确**不收**的前缀（导航类，静默跳过 —— 不提示、不计入 G3）：
//   `find` = 包内去哪找 · `pit` = 包内什么坑
const IGNORED = ['find', 'pit'];

// `- \`<key>\` — 值` 的行（链上与总表同构，唯一区别：总表多一段真源指针）
const KEY_LINE = /^\s*[-*]\s+`([^`]+)`\s+—/;
// 总表条目：`- \`<中文 key>\` — 一句话 → 真源 <指针>`
const ENTRY = /^\s*[-*]\s+`([^`]+)`\s+—\s+(.+?)\s*→\s*真源\s+(.+?)\s*$/;
// 指针两种形态：
//   ① 正文已落 AGENTS.md：`<绝对路径>` 的 `<英文 key>`
//   ② 规范已定、正文还散在任务 body（**待落位**）：任务 `<任务 URI>` 的 `<锚文本>`
const PTR_TASK = /^任务\s+`?([^`\s]+)`?\s+的\s+`(.+)`$/;
const PTR_FILE = /^`?([^`]+?)`?\s+的\s+`(.+)`$/;

const read = (p: string) => readFileSync(p, 'utf8');
const expand = (p: string) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

/**
 * 主仓所在的**容器目录**（`~/git/diy`）—— worktree 里 ROOT 是
 * `~/git/diy.worktrees/t388-…`，沿路径上溯走不到它，但那一层的 AGENTS.md
 * （`rule.gpg` / `dev.*` 等仓级规范）同样是本仓上下文，不扫 = 漏。
 * 取法是 `git rev-parse --git-common-dir`（worktree 与主仓共享 .git）→ 上溯两级。
 */
function repoContainerDir(): string | null {
  try {
    const common = execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const container = path.dirname(path.dirname(common)); // <仓>/.git → <仓> → 其父
    return container === ROOT ? null : container; // 主仓里跑时容器就是 ROOT 的父，去重交给下面的 Set
  } catch {
    return null; // 非 git 检出（CI tarball / 导出目录）：跳过，不算失败
  }
}

/**
 * G3 的扫描范围（**一句话**）：`~/AGENTS.md` → `~/git/AGENTS.md` → `~/git/diy/AGENTS.md`
 * → 仓根 `AGENTS.md` → `pkgs.ts/diy-app/AGENTS.md`，共 5 份；**不含** `pkgs.ts/` 其余各包。
 *
 * 为什么收窄到 5 份（review1 裁决）：本表是「**跨领域**规范索引」，包内 `find.*` / `pit.*`
 * 是包局部事实（去哪找代码 / 这个包什么坑）。把 7 个包全扫进来只会让「265/300 未收录」这种
 * 噪声长期常驻，而常驻 warning 等于没有 warning（告警疲劳）—— 剩下真没收录的才是真欠账，
 * 值得逐条认领。故只保留**主线应用包**（`diy-app`，它承载 UI / 日志 / 环境感知等跨领域规范），
 * 其余包一律不看：不扫、不计、不提示。
 */
function agentsChain(): string[] {
  const dirs: string[] = [];
  let dir = ROOT;
  while (true) {
    dirs.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir || dir === HOME) break;
    dir = parent;
  }
  if (dirs[0] !== HOME) dirs.splice(0, 0, HOME); // 仓不在家目录下：家目录那条仍要算
  const files = dirs.map((d) => path.join(d, 'AGENTS.md')).filter((f) => existsSync(f));
  // 主仓容器层（worktree 里沿路径上溯走不到 `~/git/diy/AGENTS.md`，见 repoContainerDir）
  const container = repoContainerDir();
  if (container) {
    const f = path.join(container, 'AGENTS.md');
    if (existsSync(f) && !files.includes(f)) files.push(f);
  }
  // 主线应用包（唯一纳入的包层；其余包故意不扫）
  const app = path.join(ROOT, 'pkgs.ts', 'diy-app', 'AGENTS.md');
  if (existsSync(app)) files.push(app);
  return files;
}

/** 扫一份文件的 `- \`<key>\` —` 行 → [{ key, line }] */
function keysOf(file: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  read(file)
    .split('\n')
    .forEach((text, i) => {
      const m = KEY_LINE.exec(text);
      if (m) out.push({ key: m[1], line: i + 1 });
    });
  return out;
}

/** 读基线（一行一个 key，`#` 注释与空行跳过） */
function readBaseline(): Set<string> {
  if (!existsSync(BASELINE)) return new Set();
  const keys = read(BASELINE)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  return new Set(keys);
}

type Issue = { kind: 'G1' | 'G2'; msg: string };

const errors: Issue[] = [];
const notes: string[] = [];

if (!existsSync(SPECS)) {
  console.log(`[check-specs] 跳过：未找到总表 ${SPECS}（家目录索引不在本机 / CI 无此文件，不算失败）`);
  process.exit(0);
}

// ── 解析总表 ──────────────────────────────────────────────────────────────────
type Entry = { line: number; key: string; pointer: string };
const entries: Entry[] = [];
read(SPECS)
  .split('\n')
  .forEach((text, i) => {
    const m = ENTRY.exec(text);
    if (m) {
      entries.push({ line: i + 1, key: m[1], pointer: m[3] });
      return;
    }
    // 长得像条目却没有真源指针 → 也是 G2 的错（索引必须指向正文）
    const k = KEY_LINE.exec(text);
    if (k) {
      errors.push({ kind: 'G2', msg: `第 ${i + 1} 行 \`${k[1]}\`：缺少「→ 真源 <指针>」` });
    }
  });

// ── G1：key 全链唯一 ──────────────────────────────────────────────────────────
const byKey = new Map<string, number[]>();
for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e.line]);
for (const [key, lines] of byKey) {
  if (lines.length > 1) errors.push({ kind: 'G1', msg: `重复 key \`${key}\`（第 ${lines.join(' / ')} 行）` });
}

// ── G2：指针可解析 ───────────────────────────────────────────────────────────
for (const e of entries) {
  const task = PTR_TASK.exec(e.pointer);
  if (task) {
    const uri = task[1];
    const anchor = task[2];
    const file = path.join(DIY_HOME, uri, 'AGENTS.md');
    if (!existsSync(file)) {
      errors.push({ kind: 'G2', msg: `第 ${e.line} 行 \`${e.key}\`：任务不存在 ${file}` });
    } else if (!read(file).includes(anchor)) {
      errors.push({ kind: 'G2', msg: `第 ${e.line} 行 \`${e.key}\`：锚文本不在 ${uri} 的 body 里：「${anchor}」` });
    }
    continue;
  }
  const ptr = PTR_FILE.exec(e.pointer);
  if (!ptr) {
    errors.push({ kind: 'G2', msg: `第 ${e.line} 行 \`${e.key}\`：指针写法不认识「${e.pointer}」` });
    continue;
  }
  const file = expand(ptr[1]);
  const key = ptr[2];
  if (!existsSync(file)) {
    errors.push({ kind: 'G2', msg: `第 ${e.line} 行 \`${e.key}\`：真源文件不存在 ${file}` });
    continue;
  }
  if (!keysOf(file).some((k) => k.key === key)) {
    errors.push({ kind: 'G2', msg: `第 ${e.line} 行 \`${e.key}\`：真源 ${file} 里没有 key \`${key}\`` });
  }
}

// ── G3：链上新增未收录（ratchet：只报基线外的）──────────────────────────────
const indexed = new Set<string>();
for (const e of entries) {
  const ptr = PTR_FILE.exec(e.pointer);
  if (ptr) indexed.add(ptr[2]);
}
const chain = agentsChain();
const onChain = new Set<string>();
for (const f of chain) {
  for (const k of keysOf(f)) {
    // 只关心 `域.对象.方面` 形态的 key（`sha-py` / `pkgs/` 那种是普通反引号文本，不是 key）
    if (!/^[A-Za-z][\w./-]*\.[\w.-]+$/.test(k.key)) continue;
    const prefix = k.key.split('.')[0];
    if (IGNORED.includes(prefix)) continue;
    if (!PREFIXES.includes(prefix)) {
      notes.push(`链上出现未登记前缀 \`${prefix}.\`（${f}:${k.line}）—— 是否该加进 PREFIXES？`);
      continue;
    }
    onChain.add(k.key); // 同名 key 在更深层 = 覆盖，索引一次即可
  }
}
const missing = [...onChain].filter((k) => !indexed.has(k));

let baseline = readBaseline();
const baselineKnown = existsSync(BASELINE) || UPDATE_BASELINE;
if (UPDATE_BASELINE) {
  writeFileSync(BASELINE, `# G3 存量基线（ratchet）：链上有、总表还没有的 key（##388）；只报「基线外」的新增遗漏。\n# 扫描范围：~/AGENTS.md → ~/git/AGENTS.md → ~/git/diy/AGENTS.md → 仓根 AGENTS.md → pkgs.ts/diy-app/AGENTS.md（5 份，不含其余包）。\n# 批量补录后刷新：npx tsx scripts/check-specs.mts --update-baseline\n${missing.join('\n')}\n`);
  baseline = new Set(missing);
  console.log(`[check-specs] 基线已更新：scripts/specs-unindexed.txt（${missing.length} 条）`);
}
const fresh = missing.filter((k) => !baseline.has(k));

// ── 报告（通过时 ≤3 行：摘要 · 可选「新增未收录」· 结论）─────────────────────
const show = (s: string) => s.replace(HOME, '~');
const shown = (keys: string[]) => (keys.length > 8 ? `${keys.slice(0, 8).join(' ')} …（共 ${keys.length} 条）` : keys.join(' '));
console.log(
  `[check-specs] 总表 ${show(SPECS)}（${entries.length} 条 · 链上 ${onChain.size} 条 key · 已索引 ${indexed.size} 条 · 基线 ${baseline.size} 条${baselineKnown ? '' : '（缺失）'}）`,
);
for (const i of errors) console.log(`  ✗ ${i.kind} ${show(i.msg)}`);
for (const n of notes) console.log(`  ⚠ ${show(n)}`);
if (fresh.length > 0) {
  console.log(`  ⚠ G3 新增未收录 ${fresh.length} 条（基线外，链上有、表里没有 —— 录进总表，或 --update-baseline 冻结）：${shown(fresh)}`);
}
if (entries.length === 0) console.log('  ⚠ 总表没有任何条目（格式：- `<中文 key>` — 一句话 → 真源 `<文件>` 的 `<key>`）');
const errCount = errors.length;
console.log(errCount > 0 ? `[check-specs] ✗ ${errCount} 个 error（G1 重复 key / G2 悬空指针必须修完）` : '[check-specs] ✅ 通过（G1/G2 0 error）');
process.exit(errCount > 0 ? 1 : 0);
