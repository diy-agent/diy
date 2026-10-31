#!/usr/bin/env node
// scripts/check-error-code.mjs —— 「新增异常必须带 code」护栏（##394；接 ./sha.sh check）
//
// 判据（任务 body「⚠️ 我对铁律 3 的订正」的第 2 条 —— 原文「每个 throw 点必须带 code」在现状下
// 不可执行：diy-app/src 有 184 处 `throw new`，机械全扫会造一堆 `app/internal-1` 假码，
// 反而污染「哪类 unknown 最该被识别」的频次统计。故改成**棘轮**）：
//
//   · 存量：`LEGACY_THROW_BASELINE` **按文件钉数、只许减**（改好一处就把数字调小，`--by-file` 出数）
//   · 增量：基线之外任何 `throw new` 不带 code ⇒ ✗
//   · 带 code 的判据（任一条成立即算数）：
//       ① 构造实参里有 `code: …`（`new Error(msg, { code: "fs/disk-full" })`）
//       ② `new InvariantError("agent/…", detail)` / 白名单类（`CODE_FIRST_ARG_CLASSES`）—— 首参是 code，但**必须是字面量且合命名约定**
//          （写变量 = 统计时 grep 不到，等于没码）
//   · 逃生口：`// error-code-ok: <非空理由>`（写在本行或上一行）—— 理由空着不算数
//
// 扫描范围 = `pkgs.ts/diy-app/src`（renderer 的 `.tsx` 不扫：手写 lexer 不认 JSX，
// 假阴性比不扫更糟 —— 与 `check-atomic-write.mjs` 同一条边界理由）。
//
// 用法：
//   node scripts/check-error-code.mjs              # 判（超基线即 exit 1）
//   node scripts/check-error-code.mjs --self-test  # 正反例自检
//   node scripts/check-error-code.mjs --list       # 只列不判
//   node scripts/check-error-code.mjs --by-file    # 每文件计数（刷新基线用）

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { maskNonCode, matchingParen } from "./lib/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIR = join(ROOT, "pkgs.ts/diy-app/src");
const SELF = "pkgs.ts/diy-app/src/shared/error-triage.ts";

/**
 * 「首参即 code」的错误类白名单。加新人前先确认：**首参真的是 `err.code`**（而不是 message），
 * 否则护栏会被骗过 —— 例如 `ValidationError(errors)` 的 code 在 errors 载荷里，不在此列。
 */
const CODE_FIRST_ARG_CLASSES = new Set(["InvariantError", "FactsStoreError", "RemoteError"]);

/** code 命名约定（与 shared/error-triage.ts::isErrorCode 同一份口径） */
const CODE_RE = /^(llm|fs|net|rpc|agent|db|ui)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LITERAL_RE = /^["'`]([^"'`$]*)["'`]$/;

/**
 * 存量基线：**按文件钉数、只许减**。
 *
 * 为什么不用 allowlist（列文件、整文件豁免）：整文件豁免会让「这个文件以后新加的裸 throw」
 * 永远不被拦 —— 而新代码恰恰是最该带 code 的。钉数则保证：改好一处基数下降，
 * 再写一处裸 throw 立刻红（分母只减不增）。
 */
const LEGACY_THROW_BASELINE = new Map(Object.entries({
  // 由 `--by-file` 生成（2026-10-20，##394 立项时实测：177 处 / 31 文件）。
  // 改好一处就把数字调小（护栏会提示），**不要往上调**。
  "pkgs.ts/diy-app/src/main/services/api-impl.ts": 32,
  "pkgs.ts/diy-app/src/main/core/flow.ts": 29,
  "pkgs.ts/diy-app/src/main/core/flow-store.ts": 21,
  "pkgs.ts/diy-app/src/main/core/llm-cost.ts": 11,
  "pkgs.ts/diy-app/src/main/core/task.ts": 8,
  "pkgs.ts/diy-app/src/main/services/local-agent.ts": 5,
  "pkgs.ts/diy-app/src/main/core/traffic-log.ts": 7,
  "pkgs.ts/diy-app/src/main/services/prompt-registry.ts": 5,
  "pkgs.ts/diy-app/src/cli/index.ts": 4,
  "pkgs.ts/diy-app/src/main/core/flow-thread.ts": 4,
  "pkgs.ts/diy-app/src/main/workflows/plugins.ts": 4,
  "pkgs.ts/diy-app/src/renderer_solid/lib/renderer-api-impl.ts": 4,
  "pkgs.ts/diy-app/src/main/core/steer-queue.ts": 3,
  "pkgs.ts/diy-app/src/main/services/rpc-port.ts": 3,
  "pkgs.ts/diy-app/src/main/core/file-read.ts": 2,
  "pkgs.ts/diy-app/src/main/core/model-config.ts": 2,
  "pkgs.ts/diy-app/src/main/core/model-runtime.ts": 2,
  "pkgs.ts/diy-app/src/main/core/persona.ts": 2,
  "pkgs.ts/diy-app/src/main/services/instances.ts": 2,
  "pkgs.ts/diy-app/src/main/core/app-root.ts": 1,
  "pkgs.ts/diy-app/src/main/core/context-config.ts": 1,
  "pkgs.ts/diy-app/src/main/core/data-file.ts": 1,
  "pkgs.ts/diy-app/src/main/core/serial-queue.ts": 1,
  "pkgs.ts/diy-app/src/main/services/flow-prompt.ts": 1,
  "pkgs.ts/diy-app/src/main/services/flow-runner.ts": 1,
  "pkgs.ts/diy-app/src/main/services/local-layout-migrate.ts": 1,
  "pkgs.ts/diy-app/src/renderer_solid/lib/notice.ts": 1,
  "pkgs.ts/diy-app/src/renderer_solid/store/notificationStore.ts": 1,
}));

/** 掩码文本上的 `throw new X(` —— 注释/字符串里的 `throw new` 天然不算 */
const THROW_RE = /\bthrow\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g;
const ANNOTATION = /\/\/\s*error-code-ok\s*:\s*(.*)$/;

/**
 * 扫一份源码，返回**没带 code 的** `throw new`：`[{ line, name, snippet }]`。
 * @param {string} src
 * @param {string} file 相对仓库路径（`error-triage.ts` 自身豁免：它就是 `invariant` 的实现）
 */
export function scanSource(src, file = "<fixture>") {
  if (file === SELF) return [];
  const masked = maskNonCode(src);
  // 行尾去掉 `\r`：CRLF 文件下 `ANNOTATION` 的 `(.*)$` 不匹配 `\r`，逃生口会静默失效
  const lines = src.split(/\r?\n/);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const hits = [];
  THROW_RE.lastIndex = 0;
  let m;
  while ((m = THROW_RE.exec(masked)) !== null) {
    const name = m[1];
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchingParen(masked, openIdx);
    if (closeIdx < 0) continue;
    const spanMasked = masked.slice(openIdx + 1, closeIdx);
    const spanRaw = src.slice(openIdx + 1, closeIdx);
    const line = lineOf(m.index);

    // ① 实参里有 `code:`
    if (/\bcode\s*:/.test(spanMasked)) continue;
    // ② 「首参即 code」的错误类（字面量 + 合命名约定）
    if (CODE_FIRST_ARG_CLASSES.has(name)) {
      // 掩码文本里字面量已成空白 —— 直接在**原文**首段上抓引号串（按掩码长度切片会切到字符串中间）
      const litVal = /^\s*["'`]([^"'`$]*)["'`]/.exec(spanRaw)?.[1] ?? "";
      if (CODE_RE.test(litVal)) continue;
      hits.push({ line, name, snippet: snippetOf(src, m.index, closeIdx), why: `${name} 的 code 必须是字面量且形如 <域>/<kebab-case>` });
      continue;
    }
    // ③ 逃生口注释（本行或上一行，理由非空）
    const prev = line >= 2 ? lines[line - 2] : "";
    const cur = lines[line - 1];
    const ann = prev.match(ANNOTATION) || cur.match(ANNOTATION);
    if (ann && ann[1].trim() !== "") continue;

    hits.push({ line, name, snippet: snippetOf(src, m.index, closeIdx) });
  }
  return hits;
}

function snippetOf(src, from, to) {
  return src.slice(from, Math.min(to + 1, from + 160)).replace(/\s+/g, " ");
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 扫全量 → `[{ file, line, name, snippet, why? }]` */
export function scanAll() {
  const out = [];
  for (const abs of walk(SCAN_DIR)) {
    // 基线键用 `/`：`relative()` 在 Windows 上给 `\`，不归一化会让全部条目失配（同 check-sync-io）
    const rel = relative(ROOT, abs).split(sep).join("/");
    const src = readFileSync(abs, "utf-8");
    for (const hit of scanSource(src, rel)) out.push({ file: rel, ...hit });
  }
  return out;
}

function selfTest() {
  const cases = [
    ["bare throw", `throw new Error("x");`, 1],
    ["code in options", `throw new Error("x", { code: "fs/disk-full" });`, 0],
    ["code multiline", "throw new Error(\n  msg,\n  { code: \"net/connection-reset\" },\n);", 0],
    ["InvariantError literal", `throw new InvariantError("agent/invariant-step-seq", "x");`, 0],
    ["InvariantError bad code", `throw new InvariantError("stepSeq");`, 1],
    ["InvariantError variable code", `const c = "agent/x";\nthrow new InvariantError(c);`, 1],
    ["FactsStoreError literal code", `throw new FactsStoreError("agent/facts-bad-in", "x");`, 0],
    ["FactsStoreError bad code", `throw new FactsStoreError("facts/repo-missing", "x");`, 1],
    ["rethrow", `try { x(); } catch (e) { throw e; }`, 0],
    ["comment only", `// throw new Error("x");`, 0],
    ["string only", `const s = "throw new Error('x')";`, 0],
    ["template only", "const s = `throw new Error(\"x\")`;", 0],
    ["escape hatch with reason", "// error-code-ok: 内联校验，码由调用方给\nthrow new Error(\"x\");", 0],
    ["escape hatch without reason", "// error-code-ok:\nthrow new Error(\"x\");", 1],
    ["escape hatch same line", `throw new Error("x"); // error-code-ok: 旧码保持`, 0],
    ["regex literal with comment markers", `const re = /\\/\\//;\nthrow new Error("x");`, 1],
    ["nested parens", `throw new Error(f("a", "b"));`, 1],
    ["other constructor", `throw new TypeError("x");`, 1],
  ];
  let bad = 0;
  for (const [name, src, want] of cases) {
    const got = scanSource(src).length;
    if (got !== want) {
      bad += 1;
      console.error(`✗ self-test ${name}: 期望 ${want}，实得 ${got}`);
    } else {
      console.log(`✓ ${name}`);
    }
  }
  if (bad > 0) {
    console.error(`\n✗ 自检失败 ${bad} 例`);
    process.exit(1);
  }
  console.log(`\n✓ 自检通过 ${cases.length} 例`);
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const hits = scanAll();
const byFile = new Map();
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);

if (argv.includes("--by-file")) {
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${f}`);
  console.log(`\n共 ${hits.length} 处（${byFile.size} 个文件）`);
  process.exit(0);
}
if (argv.includes("--list")) {
  for (const h of hits) console.log(`${h.file}:${h.line}\t${h.name}\t${h.snippet}`);
  console.log(`\n共 ${hits.length} 处（仅列不判）`);
  process.exit(0);
}

// 基线腐坏防护：基线里的文件必须还在（否则这个数字永远拦不到东西）
for (const f of LEGACY_THROW_BASELINE.keys()) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`✗ 基线条目失效（文件不存在）：${f}`);
    process.exitCode = 1;
  }
}

const grew = [];
const shrank = [];
for (const [file, n] of byFile) {
  const base = LEGACY_THROW_BASELINE.get(file) ?? 0;
  if (n > base) grew.push({ file, base, n, extra: hits.filter((h) => h.file === file) });
  else if (n < base) shrank.push({ file, base, n });
}
const gone = [...LEGACY_THROW_BASELINE.keys()].filter((f) => !byFile.has(f));

if (grew.length > 0) {
  const extra = grew.reduce((s, g) => s + (g.n - g.base), 0);
  console.error(`✗ 有 ${extra} 处新增 \`throw new\` 没带 code（基线 ${LEGACY_THROW_BASELINE.size} 个文件 / ${[...LEGACY_THROW_BASELINE.values()].reduce((a, b) => a + b, 0)} 处）\n`);
  for (const g of grew) {
    console.error(`  ${g.file}：基线 ${g.base} → 实际 ${g.n}`);
    for (const h of g.extra) console.error(`    ${h.file}:${h.line}\t${h.snippet}${h.why ? `\n      ↳ ${h.why}` : ""}`);
  }
  console.error(`\n  处置：给异常加 code（形如 \`fs/disk-full\` / \`llm/rate-limited\` / \`agent/invariant-step-seq\`）：`);
  console.error(`        throw new Error(msg, { code: "fs/disk-full" })   // 或 throw new InvariantError("agent/…", detail)`);
  console.error(`        确无判据可比（纯防御性 throw）时，写「// error-code-ok: <理由>」并**不要再减基线**。`);
  console.error(`  见 rule.err-triage（##394）：新增 throw 必须带 code；存量按基线只减不增。`);
  process.exit(1);
}
if (shrank.length > 0 || gone.length > 0) {
  console.log(`ℹ 基线可收紧（改好之后请下调 LEGACY_THROW_BASELINE）：`);
  for (const s of shrank) console.log(`  ${s.file}：基线 ${s.base} → 实际 ${s.n}`);
  for (const f of gone) console.log(`  ${f}：基线 ${LEGACY_THROW_BASELINE.get(f)} → 已无裸 throw`);
}
if (process.exitCode === 1) process.exit(1);
console.log(`✓ error-code 护栏通过：存量 ${hits.length} 处全部在基线内，新增一律带 code`);
