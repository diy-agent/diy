#!/usr/bin/env node
// scripts/check-atomic-write.mjs —— 整文件覆盖写护栏（##383；已接 ./sha.sh check）
//
// 判据：Node 侧源码（`src/{main,serve,preload}/**/*.ts`）里出现「直接把内容盖到目标文件」的调用即违规，
// 除非满足下列任一豁免：
//   ① 目标路径是临时文件腿（首参含 `.tmp` / `mkdtemp`）—— 即 tmp+rename 原子写；
//   ② 调用行或紧邻上一行有 `// non-atomic-ok: <非空理由>`（append-only / 仅人读标记等）；
//   ③ 调用行或紧邻上一行有 `// atomic-ok: <非空理由>`（极少数不能复用共享原语的原子实现）；
//   ④ 命中 `scripts/atomic-write-allowlist.txt`（`<相对路径>\t<理由>`；**列的文件不存在 = 报错**，
//      防白名单腐坏。该文件本身不存在不算错 —— 一条不加是正常态）。
// 共享原语 `writeFileAtomic(` 不在检查名单里，天然通过。
//
// 用法：
//   node scripts/check-atomic-write.mjs              # 扫全量，违规即 exit 1
//   node scripts/check-atomic-write.mjs --self-test  # 正反例自检（CI/check 调用）
//   node scripts/check-atomic-write.mjs --list       # 只列不判（迁移期看基线）

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { maskNonCode, matchingParen } from "./lib/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 扫描范围：**Node 侧**（main / serve / preload，都能 `import fs`）。
// 不扫 renderer_solid 的 `.tsx`：手写 lexer 不认 JSX（JSX 文本里的 `'`、闭合标签的 `</`
// 会把后续代码当字符串/正则吞掉 ⇒ 假阴性比不扫更糟）；且 renderer 根本拿不到 `fs`
// —— `src/main/index.ts:280-281` 是 `contextIsolation: true` + `nodeIntegration: false`。
// renderer 若要落盘只能经 preload 的 contextBridge 暴露的方法（真正的防线是那个白名单
// `src/preload/index.ts`）；为此本脚本另有一条精确检查：renderer 里出现 `fs` 导入即违规
// （见 checkRendererFsImports）。
const SCAN_DIRS = [
  ...["main", "serve", "preload"].map((d) => join(ROOT, "pkgs.ts/diy-app/src", d)),
  // ##5 第 11 轮 A：事实库的落盘也在射程内。原先只扫 diy-app ⇒ `facts submit` 的
  // 半截写（固定 tmp 名 / 不做两阶段 / 不继承权限）永远不会被 check 拦。
  join(ROOT, "pkgs.ts/diy-facts/src"),
];
/**
 * 共享原语（**豁免**：它们内部就是要直接调 `writeFileSync`）。
 * 两份是有意的：依赖方向 `diy-app → diy-facts`，facts 不能 import diy-app 的 core，
 * 故各自自持一份、语义必须一致（改一处要改两处）。
 */
const UTIL_FILES = new Set([
  join(ROOT, "pkgs.ts/diy-app/src/main/core/atomic-write.ts"),
  join(ROOT, "pkgs.ts/diy-facts/src/node/atomic-write.ts"),
]);
const ALLOWLIST = join(ROOT, "scripts/atomic-write-allowlist.txt");

const RENDERER_DIR = join(ROOT, "pkgs.ts/diy-app/src/renderer_solid");
/** 直接覆盖目标文件的 API；`openSync(..., "w")` 单独判 flags。
 *  `truncateSync` / `ftruncateSync` 把目标截成 0 字节，`cpSync` / `cp` 覆盖第二个实参 —— 同罪。 */
const WRITE_APIS = new Set([
  "writeFileSync", "writeFile", "copyFileSync", "copyFile", "outputFile", "createWriteStream",
  "truncateSync", "ftruncateSync", "cpSync", "cp",
]);
/** 目标文件是**第几个实参**（0-based）：copy 族源在前、目标在后 */
const TARGET_ARG = { copyFileSync: 1, copyFile: 1, cpSync: 1, cp: 1 };
/** renderer 拿 fs 的唯一途径（nodeIntegration=false 下等于「不可能」）—— 真出现就是防线破了 */
const FS_IMPORT = /(?:from\s*["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\))/;
const ANNOTATION = /\/\/\s*(non-atomic-ok|atomic-ok)\s*:\s*(.*)$/;

/** 取第 n 个顶层实参（在掩码后文本上按逗号切）；越界返回 null */
function nthArg(masked, openIdx, closeIdx, n = 0) {
  let depth = 0;
  let start = openIdx + 1;
  let seen = 0;
  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      if (seen === n) return [start, i];
      seen += 1;
      start = i + 1;
    }
  }
  return seen === n ? [start, closeIdx] : null;
}

/** 扫描一份源码，返回违规调用 [{ line, name, snippet }] */
export function scanSource(src, file = "<fixture>") {
  const masked = maskNonCode(src);
  // 行尾统一去掉 `\r`：仓库文件在 Windows 上是 CRLF，而 `ANNOTATION` 的 `(.*)$` 里
  // `.` 不匹配 `\r` ⇒ 不归一化会让所有「同行/上一行的 non-atomic-ok」在 Windows 上**静默失效**。
  const lines = src.split(/\r?\n/);
  // 临时文件变量：`const tmp = p + ".tmp"` / `const tmp = `${p}.tmp-${pid}``
  const tempVars = new Set();
  for (const tm of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (/\.tmp\b|\.tmp-|mkdtemp/.test(tm[2])) tempVars.add(tm[1]);
  }
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  // 别名：`import { writeFileSync as wfs }` —— 别名调用同样管辖
  const aliases = new Map();
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g)) {
    for (const part of im[1].split(",")) {
      const mm = part.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mm && (WRITE_APIS.has(mm[1]) || mm[1] === "openSync")) aliases.set(mm[2], mm[1]);
    }
  }
  const hits = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  const covered = []; // 已判定过的调用区间（openIdx），避免 openSync 与内层重复计数
  let m;
  while ((m = re.exec(masked)) !== null) {
    const rawName = m[1];
    const name = aliases.get(rawName) ?? rawName;
    const openIdx = m.index + m[0].length - 1;
    if (!WRITE_APIS.has(name) && name !== "openSync") continue;
    if (covered.some(([a, b]) => openIdx >= a && openIdx <= b)) continue;
    const closeIdx = matchingParen(masked, openIdx);
    if (closeIdx < 0) continue;
    covered.push([openIdx, closeIdx]);
    const argsRaw = src.slice(openIdx + 1, closeIdx);
    // 目标文件所在的实参：copy 族是第 2 个（源在前），其余是第 1 个
    const targetSpan = nthArg(masked, openIdx, closeIdx, TARGET_ARG[name] ?? 0);
    const target = targetSpan ? src.slice(targetSpan[0], targetSpan[1]).trim() : "";

    if (name === "openSync") {
      if (!/["']w["']/.test(argsRaw)) continue; // "a" / "r" 不算覆盖写
    }
    if (name === "createWriteStream") {
      if (/flags\s*:\s*["']a["']/.test(argsRaw) || /^\s*["']a["']/.test(argsRaw.split(",")[1] ?? "")) continue;
    }
    if (UTIL_FILES.has(resolve(file))) continue;

    // 豁免 ①：临时文件腿（**目标**是 `.tmp` 字面量或指向 tmp 的变量）
    // 注：`ftruncateSync(fd)` 的首参是 fd、看不到路径 ⇒ 拿不到 tmp 腿，一律报（该改就改）
    if (/\.tmp\b|\.tmp-|mkdtemp/.test(target)) continue;
    if (tempVars.has(target)) continue;
    // `const t = await mkdtemp(…); writeFileSync(join(t, "f"), x)` —— tmp 变量经 join() 间接传参
    if ([...tempVars].some((v) => new RegExp(`(^|[^\\w$.])${v.replace(/[$]/g, "\\$")}([^\\w$]|$)`).test(target))) continue;

    // 豁免 ②③：同行或上一行注释
    const line = lineOf(openIdx);
    const prev = line >= 2 ? lines[line - 2] : "";
    const cur = lines[line - 1];
    const ann = prev.match(ANNOTATION) || cur.match(ANNOTATION);
    if (ann && ann[2].trim() !== "") continue;

    hits.push({ line, name, snippet: src.slice(openIdx, Math.min(closeIdx + 1, openIdx + 120)).replace(/\s+/g, " ") });
  }
  return hits;
}

function walk(dir, exts = [".ts"]) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** 单行是否 `import … from "fs"` / `require("fs")`（供 renderer 防线与自检用） */
export function hasFsImport(line) {
  return FS_IMPORT.test(line);
}

/** renderer 侧不判「整文件覆盖写」（nodeIntegration=false ⇒ 拿不到 fs），
 *  但**导入 fs** 这件事本身就是防线破了 ⇒ 单独拦（纯文本匹配，不依赖 lexer 认 JSX）。 */
export function scanRendererLeaks() {
  if (!existsSync(RENDERER_DIR)) return [];
  const out = [];
  for (const abs of walk(RENDERER_DIR, [".ts", ".tsx"])) {
    readFileSync(abs, "utf-8").split("\n").forEach((line, idx) => {
      if (hasFsImport(line)) {
        out.push({ file: relative(ROOT, abs), line: idx + 1, snippet: line.trim().slice(0, 120) });
      }
    });
  }
  return out;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) return new Map();
  const map = new Map();
  for (const raw of readFileSync(ALLOWLIST, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [path, ...rest] = line.split("\t");
    const reason = rest.join("\t").trim();
    map.set(path.trim(), reason);
  }
  return map;
}

function selfTest() {
  const cases = [
    ["plain writeFileSync", `writeFileSync(p, x, "utf-8");`, 1],
    ["fs.promises.writeFile", `await fs.promises.writeFile(p, x);`, 1],
    ["openSync w", `const fd = openSync(p, "w");`, 1],
    ["openSync a (append)", `const fd = openSync(p, "a");`, 0],
    ["copyFileSync", `copyFileSync(a, b);`, 1],
    ["createWriteStream (truncate)", `createWriteStream(p);`, 1],
    ["createWriteStream append", `createWriteStream(p, { flags: "a" });`, 0],
    ["appendFileSync", `appendFileSync(p, line, "utf-8");`, 0],
    ["writeFileAtomic (shared util)", `writeFileAtomic(p, x);`, 0],
    ["tmp + rename", "const tmp = `${p}.tmp`;\nwriteFileSync(tmp, x, \"utf-8\");\nrenameSync(tmp, p);", 0],
    ["multiline tmp first arg", "writeFileSync(\n  `${p}.tmp-${process.pid}`,\n  content,\n);", 0],
    ["non-atomic-ok with reason", "// non-atomic-ok: append-only marker\nwriteFileSync(p, x);", 0],
    ["non-atomic-ok without reason", "// non-atomic-ok:\nwriteFileSync(p, x);", 1],
    ["atomic-ok with reason", "writeFileSync(p, x); // atomic-ok: fd 语义保留", 0],
    ["comment only", "// writeFileSync(p, x);", 0],
    ["string only", `const s = "writeFileSync(p, x)";`, 0],
    ["import line", `import { writeFileSync } from "node:fs";`, 0],
    ["import alias", `import { writeFileSync as wfs } from "node:fs";\nwfs(p, x);`, 1],
    ["call inside template expression", "const s = `x${writeFileSync(p, v)}`;", 1],
    ["fs namespace call", `fs.writeFileSync(p, x);`, 1],
    ["tmp var via join", "const tmp = path.join(d, 'x.tmp');\nwriteFileSync(tmp, x);", 0],
    // R2：正则字面量含 `//`（手写 lexer 不认会整行失明）
    ["regex literal // same line", "const re = /\\/\\//; writeFileSync(p, x);", 1],
    ["regex literal // next line", "const re = /\\/\\//;\nwriteFileSync(p, x);", 1],
    ["regex char class with /", "const re = /[/]/; writeFileSync(p, x);", 1],
    ["division is not regex", "const x = a / b; writeFileSync(p, x);", 1],
    // R3：截断 / 拷贝族
    ["truncateSync", "truncateSync(p, 0);", 1],
    ["ftruncateSync", "ftruncateSync(fd, 0);", 1],
    ["cpSync", "cpSync(a, b);", 1],
    ["cpSync onto tmp leg (atomic)", "cpSync(src, `${p}.tmp`);\nrenameSync(`${p}.tmp`, p);", 0],
    ["copyFileSync onto tmp leg (atomic)", "copyFileSync(src, `${p}.tmp`);", 0],
    ["mkdtemp dir via join (atomic)", "const t = await mkdtemp(join(os.tmpdir(), \"x-\"));\nwriteFileSync(join(t, \"f\"), x);", 0],
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
  // renderer 防线：fs 导入判定
  const importCases = [
    ['import fs', `import { readFile } from "node:fs";`, 1],
    ["import fs/promises", `import fs from "fs/promises";`, 1],
    ['require("fs")', `const fs = require("fs");`, 1],
    ["ipc only", `const r = await window.diy.call("task.show", {});`, 0],
  ];
  for (const [name, line, want] of importCases) {
    const got = hasFsImport(line) ? 1 : 0;
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
  console.log(`\n✓ 自检通过 ${cases.length + importCases.length} 例`);
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const allowlist = loadAllowlist();
const violations = [];
const files = SCAN_DIRS.flatMap((d) => (existsSync(d) ? walk(d) : []));
for (const abs of files) {
  const rel = relative(ROOT, abs);
  const src = readFileSync(abs, "utf-8");
  for (const hit of scanSource(src, abs)) {
    if (allowlist.has(rel)) continue;
    violations.push({ file: rel, ...hit });
  }
}
const leaks = scanRendererLeaks();
for (const v of leaks) {
  console.error(`✗ renderer 直连 fs（nodeIntegration=false 下唯一可能是防线破了）：${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
  process.exitCode = 1;
}
for (const p of allowlist.keys()) {
  if (!existsSync(join(ROOT, p))) {
    console.error(`✗ 白名单条目失效（文件不存在）：${p}`);
    process.exitCode = 1;
  }
}
if (argv.includes("--list")) {
  for (const v of violations) console.log(`${v.file}:${v.line}\t${v.name}\t${v.snippet}`);
  console.log(`\n共 ${violations.length} 处（仅列不判）`);
  process.exit(process.exitCode ?? 0); // R4：别把白名单/泄漏的 exitCode 冲成 0
}
if (violations.length > 0) {
  console.error(`✗ 整文件覆盖写未原子化：${violations.length} 处\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
  }
  console.error(`\n  处置：改用 core/atomic-write.ts 的 writeFileAtomic()；`);
  console.error(`        确不能原子化的，在调用行/上一行写「// non-atomic-ok: <理由>」；`);
  console.error(`        批量生成物可进 scripts/atomic-write-allowlist.txt（须写理由）。`);
  process.exit(1);
}
// R6：结论行必须与退出码同义 —— 有泄漏时打 ✗，绝不让 ✓ 与「有泄漏」同现（虚假的安全感）。
if (leaks.length > 0) {
  console.error(`✗ 整文件覆盖写护栏：renderer 有 fs 导入 ${leaks.length} 处`);
  process.exit(1);
}
console.log(`✓ 整文件覆盖写护栏通过（扫描 ${files.length} 个 .ts + renderer 无 fs 导入）`);
