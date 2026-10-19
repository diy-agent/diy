#!/usr/bin/env node
// scripts/check-specs.mts — 各领域规范索引总表 `~/SPECS.md` 的查重护栏（##388）。
//
// 为什么需要它：各层 AGENTS.md 里的跨领域规范（UI / 日志 / 环境感知 / 错误 …）要**集体
// review**，却散在 5 份链文件 + 任务 body 里，光靠人记不出「这条是不是已经有了」。本脚本
// 用机器保证**不重复**：
//   G1 key 全链唯一            —— 总表里同一个中文 key 出现两次 = error
//   G2 指针可解析              —— 每条的真源（文件 + 英文 key，或任务 + 锚文本）必须真在那儿 = error
//   G3 AGENTS.md 链上的 key 未收录 —— 扫链上所有 `- \`<key>\` —` 行，没进总表的报出 = warning
//                                   （先 warning：链上 ~237 条，一次录满不现实；稳定后再升 error）
//
// 总表**只做索引**，正文仍住各层 AGENTS.md —— 分层加载是刚需（cwd 决定加载哪些、读链即得
// 全文），总表是给人 review 的视图。故 G2 是**硬**的：指针悬空 = 索引在撒谎。
//
// 总表缺失（跨机器 / CI 没有家目录那份文件）⇒ 打印跳过提示、退出 0，不算失败。
//
// 用法：
//   npx tsx scripts/check-specs.mts              默认查 ~/SPECS.md
//   npx tsx scripts/check-specs.mts <specs.md>   指定总表（可测性 / 演练）
//   DIY_SPECS=<path> 同效
//
// 退出码：0 = 通过（含「总表缺失跳过」）· 1 = 有 error
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DIY_HOME = process.env.DIY_HOME ?? path.join(HOME, '.diy');

// 总表位置：家目录（与 ~/AGENTS.md 并列，跨项目 —— 索引对象本身跨项目）
const SPECS = path.resolve(process.argv[2] ?? process.env.DIY_SPECS ?? path.join(HOME, 'SPECS.md'));

// G3 的 key 前缀白名单：**按实测收口**（2026-10-19 扫 5 份链，实际只有这 10 个前缀）。
// 白名单外的前缀不静默吞掉 —— 见到就提示「是否该加进来」，否则新领域永远看不见。
const PREFIXES = ['rule', 'tool', 'proj', 'data', 'find', 'dev', 'entry', 'model', 'pit', 'env'];

// `- \`<key>\` — 值` 的行（链上与总表同构，唯一区别：总表多一段真源指针）
const KEY_LINE = /^\s*[-*]\s+`([^`]+)`\s+—/;
// 总表条目：`- \`<中文 key>\` — 一句话 → 真源 <指针>`
const ENTRY = /^\s*[-*]\s+`([^`]+)`\s+—\s+(.+?)\s+→\s*真源\s+(.+?)\s*$/;
// 指针两种形态：
//   ① 正文已落 AGENTS.md：`<绝对路径>` 的 `<英文 key>`
//   ② 规范已定、正文还散在任务 body（**待落位**）：任务 `<任务 URI>` 的 `<锚文本>`
const PTR_TASK = /^任务\s+`?([^`\s]+)`?\s+的\s+`(.+)`$/;
const PTR_FILE = /^`?([^`]+?)`?\s+的\s+`(.+)`$/;

const read = (p: string) => readFileSync(p, 'utf8');
const expand = (p: string) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

/** AGENTS.md 链：家目录 → 仓根逐层（深层同名 key 覆盖浅层）+ 包层 */
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
  // 包层（pkgs.ts/<包>/AGENTS.md）
  const pkgsDir = path.join(ROOT, 'pkgs.ts');
  if (existsSync(pkgsDir)) {
    for (const d of readdirSync(pkgsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(pkgsDir, d.name, 'AGENTS.md');
      if (existsSync(f)) files.push(f);
    }
  }
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

// ── G3：AGENTS.md 链上未收录（warning）─────────────────────────────────────────
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
    if (!PREFIXES.includes(prefix)) {
      notes.push(`链上出现未登记前缀 \`${prefix}.\`（${f}:${k.line}）—— 是否该加进 PREFIXES？`);
      continue;
    }
    onChain.add(k.key); // 同名 key 在更深层 = 覆盖，索引一次即可
  }
}
const missing = [...onChain].filter((k) => !indexed.has(k));
const missingByPrefix = new Map<string, string[]>();
for (const k of missing) {
  const p = k.split('.')[0];
  missingByPrefix.set(p, [...(missingByPrefix.get(p) ?? []), k]);
}

// ── 报告 ──────────────────────────────────────────────────────────────────────
const show = (s: string) => s.replace(HOME, '~');
console.log(`[check-specs] 总表：${show(SPECS)}（${entries.length} 条 · 链上 ${onChain.size} 条 key · 已索引 ${indexed.size} 条）`);
for (const i of errors) console.log(`  ✗ ${i.kind} ${show(i.msg)}`);
for (const n of notes) console.log(`  ⚠ ${show(n)}`);
if (missing.length > 0) {
  console.log(`  ⚠ G3 未收录 ${missing.length}/${onChain.size} 条（warning：正文已在 AGENTS.md，本表还没有索引 —— 逐步补，稳定后升 error）`);
  for (const [prefix, keys] of [...missingByPrefix].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`     ${prefix} (${keys.length}): ${keys.join(' ')}`);
  }
}
if (entries.length === 0) console.log('  ⚠ 总表没有任何条目（格式：- `<中文 key>` — 一句话 → 真源 `<文件>` 的 `<key>`）');
const errCount = errors.length;
console.log(errCount > 0 ? `[check-specs] ✗ ${errCount} 个 error（G1 重复 key / G2 悬空指针必须修完）` : '[check-specs] ✅ 通过（G1/G2 0 error）');
process.exit(errCount > 0 ? 1 : 0);
