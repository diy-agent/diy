#!/usr/bin/env node
// scripts/check-sync-io.mjs —— 「app 里不许有同步 IO」护栏（##408 刀 16；接 ./sha.sh check）
//
// 用户 2026-10-24 原话：「我们 app 不允许有 sync 的 io 操作，修复，并更新规范」。
//
// 判据（为什么是棘轮而不是一刀切）：
//   主进程是**单线程事件循环**，任何 `*Sync` 的磁盘/子进程调用都把渲染、RPC、流式输出一起按停。
//   但它不总是 bug：启动早期的读写、原子写工具本身、CLI 的一次性初始化，都在
//   「没有并发可挡」的窗口里。全仓机械改异步会造出比问题更大的风险（300+ 处、无测试覆盖的
//   调用链），所以这里与 `check-error-code.mjs` 同一个手法：
//
//   · 存量：`LEGACY_SYNC_IO_BASELINE` **按文件钉数、只许减**（改好一处就把数字调小）
//   · 增量：基线之外任何同步 IO ⇒ ✗（新代码没有"存量"可推）
//   · 逃生口：`// sync-io-ok: <非空理由>`（写在本行或上一行）—— 理由空着不算数
//
// 扫描范围 = `pkgs.ts/diy-app/src/{main,shared,preload}`（renderer 不用 fs；
// 测试文件不扫 —— 测试里同步读写反而更可读，且不在事件循环的关键路径上）。
//
// 用法：
//   node scripts/check-sync-io.mjs              # 判（超基线即 exit 1）
//   node scripts/check-sync-io.mjs --self-test  # 正反例自检（护栏坏了要立刻发现）
//   node scripts/check-sync-io.mjs --list       # 只列不判
//   node scripts/check-sync-io.mjs --by-file    # 每文件计数（刷新基线用）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskNonCode } from "./lib/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = [
  join(ROOT, "pkgs.ts/diy-app/src/main"),
  join(ROOT, "pkgs.ts/diy-app/src/shared"),
  join(ROOT, "pkgs.ts/diy-app/src/preload"),
];

/**
 * 同步 IO 的**判据**（只认这些名字，不做"看到 Sync 就算"的模糊匹配 ——
 * `useSyncExternalStore` 之类的误报会让护栏失去可信度）。
 */
const SYNC_RE =
  /\b(?:readFileSync|writeFileSync|appendFileSync|mkdirSync|mkdtempSync|readdirSync|rmSync|rmdirSync|unlinkSync|statSync|lstatSync|fstatSync|existsSync|accessSync|openSync|closeSync|writeSync|readSync|copyFileSync|renameSync|cpSync|chmodSync|realpathSync|readlinkSync|symlinkSync|truncateSync|execSync|execFileSync|spawnSync)\s*\(/g;

/**
 * 存量基线：**按文件钉数、只许减**。
 *
 * 由 `--by-file` 生成（2026-10-24，##408 刀 16）。改好一处就把数字调小
 * （护栏会提示"基线偏大"），**不要往上调** —— 上调等于宣布"新代码也可以同步"。
 */
const LEGACY_SYNC_IO_BASELINE = new Map(Object.entries({
  // 由 `--by-file` 生成（2026-10-24，##408 刀 16 立项时实测：318 处 / 52 文件）。
  // 改好一处就把数字调小（护栏会提示），**不要往上调**。
  "pkgs.ts/diy-app/src/main/core/app-config.ts": 2,
  "pkgs.ts/diy-app/src/main/core/atomic-write.ts": 8,
  "pkgs.ts/diy-app/src/main/core/auto-compact-config.ts": 5,
  "pkgs.ts/diy-app/src/main/core/calendars.ts": 1,
  "pkgs.ts/diy-app/src/main/core/context-changelog.ts": 3,
  "pkgs.ts/diy-app/src/main/core/context-config.ts": 2,
  "pkgs.ts/diy-app/src/main/core/context-stats.ts": 4,
  "pkgs.ts/diy-app/src/main/core/cost-windows.ts": 1,
  "pkgs.ts/diy-app/src/main/core/cwd.ts": 2,
  "pkgs.ts/diy-app/src/main/core/data-file.ts": 1,
  "pkgs.ts/diy-app/src/main/core/drafts.ts": 3,
  "pkgs.ts/diy-app/src/main/core/file-edit.ts": 4,
  "pkgs.ts/diy-app/src/main/core/file-write.ts": 7,
  "pkgs.ts/diy-app/src/main/core/flow-store.ts": 17,
  "pkgs.ts/diy-app/src/main/core/flow.ts": 5,
  "pkgs.ts/diy-app/src/main/core/fs-lock.ts": 5,
  "pkgs.ts/diy-app/src/main/core/gpu-detect.ts": 1,
  "pkgs.ts/diy-app/src/main/core/instance-identity.ts": 3,
  "pkgs.ts/diy-app/src/main/core/instance-registry.ts": 6,
  "pkgs.ts/diy-app/src/main/core/local-paths.ts": 5,
  "pkgs.ts/diy-app/src/main/core/model-config.ts": 4,
  "pkgs.ts/diy-app/src/main/core/model-registry.ts": 1,
  "pkgs.ts/diy-app/src/main/core/models-sync.ts": 2,
  "pkgs.ts/diy-app/src/main/core/persona.ts": 4,
  "pkgs.ts/diy-app/src/main/core/project.ts": 12,
  // ##427：room 事件流 / 投递状态改异步 + 尾部倒读（读侧 + 写侧），剩 readRoom / listRooms 两处小文件同步读
  "pkgs.ts/diy-app/src/main/core/room.ts": 5,
  "pkgs.ts/diy-app/src/main/core/seed.ts": 4,
  "pkgs.ts/diy-app/src/main/core/single-instance.ts": 3,
  "pkgs.ts/diy-app/src/main/core/state.ts": 5,
  "pkgs.ts/diy-app/src/main/core/task-tree.ts": 6,
  "pkgs.ts/diy-app/src/main/core/task.ts": 11,
  "pkgs.ts/diy-app/src/main/core/traffic-log.ts": 21,
  "pkgs.ts/diy-app/src/main/index.ts": 1,
  "pkgs.ts/diy-app/src/main/services/agent-audit.ts": 9,
  "pkgs.ts/diy-app/src/main/services/agent-guard.ts": 1,
  "pkgs.ts/diy-app/src/main/services/api-impl.ts": 5,
  "pkgs.ts/diy-app/src/main/services/compact-plan-io.ts": 9,
  "pkgs.ts/diy-app/src/main/services/crash-reporting.ts": 2,
  "pkgs.ts/diy-app/src/main/services/diagnostics.ts": 9,
  "pkgs.ts/diy-app/src/main/services/error-report.ts": 2,
  "pkgs.ts/diy-app/src/main/services/health.ts": 2,
  "pkgs.ts/diy-app/src/main/services/instances.ts": 3,
  "pkgs.ts/diy-app/src/main/services/interrupted-cause.ts": 5,
  // ⚠️ 27 → 38 是一次**对齐**，不是放宽：基线是在本护栏立项的分支上算的，之后 main 进了
  // ##419（bash 结果头）与 ops-seek，那些同步 IO 属存量代码、本护栏当时还没见过它们。
  // 判据：这 11 处**一行都不是**本分支新增（count 与 `origin/main` 上的同名文件逐一相同）。
  // 同一文件再涨就是新代码了 —— 那要改异步，不许再调这个数。
  "pkgs.ts/diy-app/src/main/services/local-agent.ts": 38,
  "pkgs.ts/diy-app/src/main/services/local-find.ts": 4,
  "pkgs.ts/diy-app/src/main/services/local-layout-migrate.ts": 19,
  "pkgs.ts/diy-app/src/main/services/local-ops-seek.ts": 14,
  "pkgs.ts/diy-app/src/main/services/ops-feed.ts": 8,
  "pkgs.ts/diy-app/src/main/services/plan-store.ts": 7,
  "pkgs.ts/diy-app/src/main/services/process-sampler.ts": 1,
  "pkgs.ts/diy-app/src/main/services/prompt-registry.ts": 16,
  "pkgs.ts/diy-app/src/main/services/tool-output.ts": 3,
}));

/** 逃生口：本行或上一行有 `// sync-io-ok: <理由>`（理由必须非空）。 */
const OK_RE = /\/\/\s*sync-io-ok:\s*(\S.*)$/;

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "build" || name === ".git") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.(ts|tsx|mts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 一个文件里的同步 IO 命中（行号 + 片段），已扣除逃生口与注释里的字样。 */
function findSyncIo(text) {
  const lines = text.split("\n");
  const masked = maskNonCode(text).split("\n");
  const hits = [];
  masked.forEach((line, i) => {
    SYNC_RE.lastIndex = 0;
    let m;
    while ((m = SYNC_RE.exec(line)) !== null) {
      const cur = lines[i] ?? "";
      const prev = lines[i - 1] ?? "";
      if (OK_RE.test(cur) || OK_RE.test(prev)) continue;
      hits.push({ line: i + 1, name: m[0].replace(/\s*\($/, ""), text: cur.trim().slice(0, 120) });
    }
  });
  return hits;
}

function scan() {
  const byFile = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file);
      const hits = findSyncIo(readFileSync(file, "utf8"));
      if (hits.length > 0) byFile.set(rel, hits);
    }
  }
  return byFile;
}

function selfTest() {
  const cases = [
    ['const s = readFileSync("x", "utf8");', 1, "同步读必须命中"],
    ['const s = await readFile("x", "utf8");', 0, "异步读不算"],
    ['// readFileSync 在注释里', 0, "注释不算"],
    ['const s = readFileSync("x"); // sync-io-ok: 启动早期没有并发可挡', 0, "逃生口（同行）"],
    ['// sync-io-ok: 理由\nconst s = readFileSync("x");', 0, "逃生口（上一行）"],
    ['const s = readFileSync("x"); // sync-io-ok:', 1, "空理由不算逃生口"],
    ['const v = useSyncExternalStore(a, b);', 0, "名字里带 Sync 但不是 IO"],
  ];
  let bad = 0;
  for (const [src, want, name] of cases) {
    const got = findSyncIo(src).length;
    if (got !== want) {
      bad += 1;
      console.error(`✗ 自检失败：${name}（期望 ${want} 命中，实得 ${got}）`);
    }
  }
  if (bad > 0) process.exit(1);
  console.log(`✓ sync-io 护栏自检通过（${cases.length} 例）`);
}

const args = new Set(process.argv.slice(2));
if (args.has("--self-test")) {
  selfTest();
  process.exit(0);
}

const byFile = scan();
if (args.has("--by-file")) {
  const rows = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [file, hits] of rows) console.log(`${hits.length}\t${file}`);
  console.log(`合计 ${rows.reduce((n, [, h]) => n + h.length, 0)} 处 / ${rows.length} 文件`);
  process.exit(0);
}
if (args.has("--list")) {
  for (const [file, hits] of byFile) for (const h of hits) console.log(`${file}:${h.line}  ${h.name}  ${h.text}`);
  process.exit(0);
}

let failed = 0;
let total = 0;
for (const [file, hits] of byFile) {
  total += hits.length;
  const base = LEGACY_SYNC_IO_BASELINE.get(file) ?? 0;
  if (hits.length > base) {
    failed += 1;
    console.error(`✗ ${file}：同步 IO ${hits.length} 处 > 基线 ${base}`);
    for (const h of hits.slice(base)) console.error(`    ${file}:${h.line}  ${h.name}  ${h.text}`);
    console.error(`    改法：用 node:fs/promises 的 await 版本（readFile / writeFile / mkdir …）；`);
    console.error(`    确实必须在同步窗口里做的，写 \`// sync-io-ok: <理由>\`。`);
  } else if (hits.length < base) {
    console.log(`↓ ${file}：${hits.length} < 基线 ${base} —— 已改好，请把基线数字调小`);
  }
}
if (failed > 0) {
  console.error(`\n[check-sync-io] ✗ ${failed} 个文件超基线（app 里不许新增同步 IO）`);
  process.exit(1);
}
console.log(`[check-sync-io] ✓ 通过（同步 IO 合计 ${total} 处 / ${byFile.size} 文件，均在基线内）`);
