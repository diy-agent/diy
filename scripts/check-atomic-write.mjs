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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 扫描范围：**Node 侧**（main / serve / preload，都能 `import fs`）。
// 不扫 renderer_solid 的 `.tsx`：手写 lexer 不认 JSX（JSX 文本里的 `'`、闭合标签的 `</`
// 会把后续代码当字符串/正则吞掉 ⇒ 假阴性比不扫更糟）；且 renderer 根本拿不到 `fs`
// —— `src/main/index.ts:280-281` 是 `contextIsolation: true` + `nodeIntegration: false`。
// renderer 若要落盘只能经 preload 的 contextBridge 暴露的方法（真正的防线是那个白名单
// `src/preload/index.ts`）；为此本脚本另有一条精确检查：renderer 里出现 `fs` 导入即违规
// （见 checkRendererFsImports）。
const SCAN_DIRS = ["main", "serve", "preload"].map((d) => join(ROOT, "pkgs.ts/diy-app/src", d));
const SCAN_DIR = SCAN_DIRS[0];
const UTIL = join(SCAN_DIR, "core/atomic-write.ts");
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

/** `/` 前一个非空白字符是这些 ⇒ 后面是**正则字面量**起点，不是除号 */
const REGEX_PREFIX_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "}"]);
/** `/` 前一个单词是这些 ⇒ 后面是正则起点（`return /x/`、`typeof /x/`） */
const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "instanceof", "new", "do", "else", "yield", "await"]);

/** 判 `/` 是除号还是正则起点（按前一个可见 token 判，ECMAScript 语法的经典近似） */
function regexAllowedBefore(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  const ch = src[j];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
    return REGEX_PREFIX_WORDS.has(src.slice(k + 1, j + 1));
  }
  if (ch === ")" || ch === "]") return false; // `f(x) / 2`、`a[i] / 2`
  return REGEX_PREFIX_PUNCT.has(ch) || ch === "/";
}

/** 把注释 / 字符串 / 模板字面量 / **正则字面量**替换成空格（保留换行与偏移），只留真代码。
 *  模板里的 `${…}` 仍按代码扫描（里面可以有真实调用）。
 *  正则字面量必须识别：`const re = /\/\//; writeFileSync(p, x)` 里的 `//` 若被当成行注释，
 *  该行后续会整段失明（假阴性）。 */
export function maskNonCode(src) {
  const out = src.split("");
  const stack = []; // "template" | "code"
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i += 1; continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push("code"); i += 2; continue; }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    // code 模式
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = src.length;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? src.length : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && regexAllowedBefore(src, i)) {
      // 正则字面量：跳过转义、字符类，直到收尾的 `/`，再吃掉 flags
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") { j += 1; break; } // 未闭合：别吞掉后续行
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { j += 1; break; }
        j += 1;
      }
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === q) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "`") { stack.push("template"); i += 1; continue; }
    if (top === "code" && c === "}") { stack.pop(); i += 1; continue; }
    i += 1;
  }
  return out.join("");
}

/** 从 `(` 起找配对的 `)`（在掩码后的代码上走，天然跳过字符串/注释） */
function matchingParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

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
  const lines = src.split("\n");
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
    if (resolve(file) === UTIL) continue;

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
console.log(`✓ 整文件覆盖写护栏通过（扫描 ${files.length} 个 .ts + renderer ${leaks.length === 0 ? "无 fs 导入" : "有泄漏"}）`);
