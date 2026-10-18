#!/usr/bin/env node
// scripts/check-sync.mjs — 「node_modules 是否落后于 package-lock.json / 源树」的只读快检。
//
// 为什么需要它：workspace 包改名（`@diy/rpc` → `@diy-agent/rpc`）或加依赖后若没重装
// node_modules，症状是**远离根因**的错 —— 例如 `Rolldown failed to resolve import
// "@diy-agent/rpc/electron"`、`Failed to resolve import "remark-gfm"`，人只会去看代码，
// 不会想到去比 package-lock.json 与 node_modules。本脚本把这类「忘了 sync」变成一行结论，
// 由根 sha.sh 的 ensure-sync 在 build/check/test/preview/lab 入口前置调用。
//
// 判据（三条，全部只读、毫秒级）：
//   1. workspace 链接：`package-lock.json` 里 `link: true` 的条目必须在 node_modules 下存在、
//      且指向对应 workspace 目录；反向也查 —— node_modules 里**任何**指进 workspace 目录的
//      软链接都必须是 lock 认可的（多出来的 = 改名残留，如 `node_modules/@diy/rpc`）
//   2. sync 印记：`node_modules/.diy-sync.stamp`（内容 = package-lock.json + 根与各包
//      package.json 的 sha256，`sync-deps` 成功时写入）与当前哈希不符 → lock/manifest 变了
//      但没 sync。**不用**「lock vs node_modules/.package-lock.json 比对」：npm 不装其它平台的
//      可选依赖（实测 101 条假阳，如 `@esbuild/darwin-x64`）
//   3. submodule：`git submodule status` 首字符 `-` = 未 init（sync 会补）
// 另有两条**只提示、不判定**（sync 修不了，故不计入退出码）：
//   node_modules/electron/{dist,path.txt} 缺失 —— electron 无 postinstall，缺了会落进
//   **无超时下载**（实测静默卡死 3m40s），见仓库根 AGENTS.md `tool.electron`
//
// 退出码：0 = 已同步 · 1 = 需要 sync · 2 = 脚本自身出错（如 package-lock.json 缺失）
// 用法：
//   node scripts/check-sync.mjs                 人读全量报告（含只提示项）
//   node scripts/check-sync.mjs --quiet         只在「需要 sync」时输出（闸门用，免每次刷屏）
//   node scripts/check-sync.mjs --json          机器读
//   node scripts/check-sync.mjs --fix           清理过期 workspace 链接后退出 0（由 sync-deps 调用：
//                                               `npm i` 只补缺失、**不清改名残留**，实测它会把
//                                               残留的 `node_modules/@diy/rpc` 留着）
//   node scripts/check-sync.mjs --write-stamp   sync 成功后写印记（由 sha.sh sync-deps 调用）
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓根（`scripts/` 的上一级）；`DIY_CHECK_SYNC_ROOT` 只为可测性留的口子（在沙箱树上验判据）
const ROOT = path.resolve(process.env.DIY_CHECK_SYNC_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const STAMP_REL = 'node_modules/.diy-sync.stamp';
const ELECTRON_REL = 'node_modules/electron';

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const JSON_OUT = argv.includes('--json');
const WRITE_STAMP = argv.includes('--write-stamp');
const FIX = argv.includes('--fix');

const abs = (rel) => path.join(ROOT, rel);

function readJson(rel) {
  return JSON.parse(readFileSync(abs(rel), 'utf8'));
}

/** 展开 workspaces 声明（只支持单段 `*`，够用：`pkgs.ts/*`），返回存在 package.json 的目录（排序后） */
function expandWorkspaces(patterns = []) {
  const out = [];
  for (const pat of patterns) {
    let dirs = [''];
    for (const seg of String(pat).replace(/\/$/, '').split('/')) {
      const next = [];
      for (const d of dirs) {
        if (seg === '*') {
          for (const e of readdirSync(abs(d), { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith('.')) next.push(path.join(d, e.name));
          }
        } else if (existsSync(abs(path.join(d, seg)))) {
          next.push(path.join(d, seg));
        }
      }
      dirs = next;
    }
    out.push(...dirs);
  }
  return out.filter((d) => existsSync(abs(path.join(d, 'package.json')))).sort();
}

/** 印记覆盖的文件：锁文件 + 根与各 workspace 的 manifest（任一变化都意味着要重装） */
function manifestFiles() {
  const files = ['package.json', 'package-lock.json'];
  for (const ws of expandWorkspaces(readJson('package.json').workspaces)) {
    files.push(path.join(ws, 'package.json'));
  }
  return files;
}

function manifestHash() {
  const h = createHash('sha256');
  for (const f of manifestFiles()) {
    h.update(f);
    h.update('\0');
    h.update(existsSync(abs(f)) ? readFileSync(abs(f)) : Buffer.from('<missing>'));
    h.update('\0');
  }
  return h.digest('hex');
}

function readStampHash() {
  try {
    const line = readFileSync(abs(STAMP_REL), 'utf8').split('\n').find((l) => l.startsWith('hash: '));
    return line ? line.slice('hash: '.length).trim() : null;
  } catch {
    return null;
  }
}

/** 软链接解析（悬空链接返回 null，调用方按「过期」处理） */
function realOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** node_modules 与其一级 @scope 目录下的软链接（相对仓根的路径，排序后） */
function scanLinks() {
  const found = [];
  const entriesOf = (dir) => {
    try {
      return readdirSync(abs(dir), { withFileTypes: true });
    } catch {
      return []; // 新 worktree 还没装 node_modules：没有链接可扫，交由「链接缺失」判据报
    }
  };
  for (const e of entriesOf('node_modules')) {
    if (e.isSymbolicLink()) {
      found.push(path.join('node_modules', e.name));
    } else if (e.isDirectory() && e.name.startsWith('@')) {
      const scope = path.join('node_modules', e.name);
      for (const s of entriesOf(scope)) {
        if (s.isSymbolicLink()) found.push(path.join(scope, s.name));
      }
    }
  }
  return found.sort();
}

/** 判据 1：workspace 链接 */
function checkLinks(lock, wsRealPaths, wsAbsPaths) {
  const issues = [];
  const expected = new Map(); // node_modules/@scope/name -> 目标目录（仓根相对）
  for (const [p, v] of Object.entries(lock.packages ?? {})) {
    if (v?.link && p.startsWith('node_modules/')) expected.set(p, v.resolved ?? '');
  }
  for (const [link, targetRel] of expected) {
    let st;
    try {
      st = lstatSync(abs(link));
    } catch {
      issues.push({ kind: 'link-missing', link, target: targetRel });
      continue;
    }
    if (!st.isSymbolicLink()) {
      issues.push({ kind: 'link-not-symlink', link, target: targetRel });
      continue;
    }
    const want = realOrNull(abs(targetRel));
    const got = realOrNull(abs(link));
    if (got === null || got !== want) {
      issues.push({ kind: 'link-wrong-target', link, target: targetRel, actual: got ? path.relative(ROOT, got) : '(悬空)' });
    }
  }

  // 反向：多出来的、指进 workspace 的链接 = 改名 / 移包残留（如 node_modules/@diy/rpc）
  for (const link of scanLinks()) {
    if (expected.has(link)) continue;
    const real = realOrNull(abs(link));
    if (real !== null && wsRealPaths.has(real)) {
      issues.push({ kind: 'link-stale', link, actual: path.relative(ROOT, real) });
      continue;
    }
    // 悬空链接：包目录已被删（realpath 解不出来），按原始目标判是否曾指向 workspace
    let raw;
    try {
      raw = readlinkSync(abs(link));
    } catch {
      continue;
    }
    if (wsAbsPaths.has(path.resolve(path.dirname(abs(link)), raw))) {
      issues.push({ kind: 'link-stale', link, actual: `${raw}（悬空）` });
    }
  }
  return issues;
}

/** 判据 2：sync 印记 */
function checkStamp() {
  const want = manifestHash();
  const got = readStampHash();
  if (got === null) {
    return { issues: [{ kind: 'stamp-missing', detail: `${STAMP_REL} 不存在（本 worktree 从未跑过 sync）` }], hash: want };
  }
  if (got !== want) {
    return { issues: [{ kind: 'stamp-stale', detail: `${STAMP_REL} 落后于当前 package-lock.json / package.json` }], hash: want };
  }
  return { issues: [], hash: want };
}

/** 判据 3：submodule 是否已 init */
function checkSubmodules() {
  let out;
  try {
    out = execFileSync('git', ['submodule', 'status', '--recursive'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return []; // 非 git 检出 / 无子模块配置：不作为判据
  }
  const issues = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('-')) issues.push({ kind: 'submodule-uninit', detail: line.slice(1).trim().split(' ').slice(1).join(' ') });
  }
  return issues;
}

/**
 * 只提示项：electron 运行时（sync 修不了，见文件头；dist 与 path.txt 缺哪个起 Electron 都会
 * 落进**无超时下载**）。
 */
function collectWarnings() {
  const warnings = [];
  if (!existsSync(abs(ELECTRON_REL))) return warnings;
  if (!existsSync(abs(`${ELECTRON_REL}/dist`))) {
    warnings.push(`${ELECTRON_REL}/dist 缺失 → 起 Electron 会落进**无超时下载**（静默卡死）。省法见 AGENTS.md tool.electron（软链主仓 dist）`);
  }
  if (!existsSync(abs(`${ELECTRON_REL}/path.txt`))) {
    warnings.push(`${ELECTRON_REL}/path.txt 缺失 → 光链 dist 不够，getElectronPath() 取不到可执行名，仍会走无超时下载（见 AGENTS.md tool.electron）`);
  }
  return warnings;
}

// ── main ──────────────────────────────────────────────────────────────────────
if (WRITE_STAMP) {
  const hash = manifestHash();
  writeFileSync(abs(STAMP_REL), `# 由 ./sha.sh sync-deps 写入；内容 = package-lock.json + 根/各包 package.json 的 sha256\nhash: ${hash}\nat: ${new Date().toISOString()}\n`);
  if (!QUIET && !JSON_OUT) console.log(`[check-sync] 已记录 sync 印记（${STAMP_REL}，hash ${hash.slice(0, 8)}）`);
  process.exit(0);
}

let lock;
try {
  lock = readJson('package-lock.json');
} catch (e) {
  console.error(`[check-sync] 读不到 package-lock.json（${ROOT}）：${e.message}`);
  process.exit(2);
}

const wsDirs = expandWorkspaces(readJson('package.json').workspaces);
const wsRealPaths = new Set(wsDirs.map((d) => realOrNull(abs(d))).filter((p) => p !== null));
const wsAbsPaths = new Set(wsDirs.map((d) => abs(d)));

const issues = [...checkLinks(lock, wsRealPaths, wsAbsPaths)];
const stamp = checkStamp();
issues.push(...stamp.issues);
issues.push(...checkSubmodules());
const warnings = collectWarnings();
const synced = issues.length === 0;

// --fix：只清理「lock 不认可的、指进 workspace 目录的软链接」（改名 / 移包残留），
// 其它一概不碰（不动实目录、不碰真实包），清完即退出 0 —— 由 sha.sh sync-deps 在 npm i 之后调用。
if (FIX) {
  const removed = [];
  for (const i of issues) {
    if (i.kind !== 'link-stale') continue;
    unlinkSync(abs(i.link));
    removed.push(i.link);
  }
  if (removed.length > 0 && !QUIET) {
    for (const link of removed) console.log(`[check-sync] 已清理过期链接：${link}`);
  }
  process.exit(0);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ synced, root: ROOT, hash: stamp.hash, issues, warnings }, null, 2));
  process.exit(synced ? 0 : 1);
}

const describe = (i) => {
  switch (i.kind) {
    case 'link-missing':
      return `workspace 链接缺失：${i.link} → ${i.target}（node_modules 里没有它，import "${i.link.replace(/^node_modules\//, '')}" 解析不到）`;
    case 'link-not-symlink':
      return `workspace 链接被实目录占位：${i.link}（应为指向 ${i.target} 的软链接 —— 删掉该目录再 sync）`;
    case 'link-wrong-target':
      return `workspace 链接指错：${i.link} → ${i.actual}（应为 ${i.target}）`;
    case 'link-stale':
      return `workspace 链接过期：${i.link} → ${i.actual}（package-lock.json 里没有这条，通常是改名残留）`;
    case 'stamp-missing':
    case 'stamp-stale':
      return `同步印记过期：${i.detail}`;
    case 'submodule-uninit':
      return `submodule 未 init：${i.detail}`;
    default:
      return `${i.kind}: ${JSON.stringify(i)}`;
  }
};

if (!synced) {
  console.log(`[check-sync] node_modules 落后于 package-lock.json / 源树 → 需要 sync`);
  for (const i of issues) console.log(`  ✗ ${describe(i)}`);
}
if (warnings.length > 0 && !QUIET) {
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (synced) {
  if (!QUIET) console.log(`[check-sync] ✅ node_modules 与 package-lock.json / 源树一致（印记 ${stamp.hash.slice(0, 8)}）`);
} else {
  console.log(`[check-sync] 处置：./sha.sh sync（build/check/test/preview/lab 入口会自动跑，DIY_AUTO_SYNC=0 关）`);
}
process.exit(synced ? 0 : 1);
