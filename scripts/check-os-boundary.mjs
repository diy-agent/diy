#!/usr/bin/env node
// scripts/check-os-boundary.mjs —— OS 边界护栏（2026-10-31，配合 src/main/os/）
//
// 规则（见 pkgs.ts/diy-app/src/main/os/README.md）：
//   · 系统假设只允许出现在 `pkgs.ts/diy-app/src/main/os/**`；
//   · 其余 main 代码必须走 `os.*` + `caps`，不许出现平台名 / 系统命令 / `process.platform`。
//
// 判据：
//   · 扫 `pkgs.ts/diy-app/src/main`（不含 os/）；
//   · 用 maskNonCode 去掉注释与字符串（注释里的历史说明是合法引用），只在**代码**上匹配；
//   · 命中令牌：process.platform / win32 / darwin / wmic / taskkill / tasklist / powershell /
//     osascript / system_profiler / Get-CimInstance / /bin/bash / bash.exe；
//   · 逃生口：`// os-boundary-ok: <非空理由>`（本行或上一行）。
//
// 用法：
//   node scripts/check-os-boundary.mjs            # 判（有越界 exit 1）
//   node scripts/check-os-boundary.mjs --list     # 只列不判
//   node scripts/check-os-boundary.mjs --self-test

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIR = join(ROOT, "pkgs.ts/diy-app/src/main");

const TOKENS =
    /process\.platform|\bwin32\b|\bdarwin\b|\bwmic\b|\btaskkill\b|\btasklist\b|\bpowershell(?:\.exe)?\b|\bpwsh(?:\.exe)?\b|\bosascript\b|system_profiler|Get-CimInstance|\/bin\/bash|bash\.exe/gi;

const ESCAPE = /\/\/\s*os-boundary-ok\s*:\s*(\S.*)$/;

function walk(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
}

/** 去掉注释但**保留字符串**（命令名就在字符串里，必须能抓到）；换行原样保留以维持行号。 */
export function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .split(/\r?\n/)
        .map((line) => {
            const at = line.indexOf("//");
            return at < 0 ? line : line.slice(0, at);
        })
        .join("\n");
}

/** 单文件扫描（导出给自检；只返回代码区的命中）。 */
export function scanSource(src, rel) {
    if (rel.startsWith("pkgs.ts/diy-app/src/main/os/")) return [];
    const code = stripComments(src);
    const rawLines = src.split(/\r?\n/);
    const codeLines = code.split(/\r?\n/);
    const hits = [];
    codeLines.forEach((line, i) => {
        TOKENS.lastIndex = 0;
        const m = TOKENS.exec(line);
        if (!m) return;
        const prev = i > 0 ? rawLines[i - 1] : "";
        const cur = rawLines[i] ?? "";
        if (ESCAPE.test(prev) || ESCAPE.test(cur)) return;
        hits.push({ line: i + 1, token: m[0], snippet: cur.trim().slice(0, 120) });
    });
    return hits;
}

function selfTest() {
    const cases = [
        ["platform branch", `if (process.platform === "win32") x();`, 1],
        ["comment only", `// 历史说明：Windows 用 taskkill`, 0],
        ["string literal command name", `const s = "taskkill";`, 1],
        ["command call", `spawn("powershell.exe", []);`, 1],
        ["escape hatch", `// os-boundary-ok: 测试夹具\nif (process.platform === "win32") x();`, 0],
        ["escape hatch without reason", `// os-boundary-ok:\nif (process.platform === "win32") x();`, 1],
        ["os dir exempt", `process.platform`, 0],
    ];
    let bad = 0;
    for (const [name, src, want] of cases) {
        const rel = name === "os dir exempt" ? "pkgs.ts/diy-app/src/main/os/index.ts" : "pkgs.ts/diy-app/src/main/x.ts";
        const got = scanSource(src, rel).length;
        if (got !== want) {
            bad += 1;
            console.error(`✗ self-test ${name}: 期望 ${want}，实得 ${got}`);
        }
    }
    if (bad > 0) process.exit(1);
    console.log(`✓ OS 边界护栏自检通过（${cases.length} 例）`);
}

const argv = new Set(process.argv.slice(2));
if (argv.has("--self-test")) {
    selfTest();
    process.exit(0);
}

const violations = [];
if (existsSync(SCAN_DIR)) {
    for (const abs of walk(SCAN_DIR)) {
        const rel = relative(ROOT, abs).split(sep).join("/");
        if (rel.startsWith("pkgs.ts/diy-app/src/main/os/")) continue;
        for (const hit of scanSource(readFileSync(abs, "utf8"), rel)) violations.push({ file: rel, ...hit });
    }
}

if (argv.has("--list")) {
    for (const v of violations) console.log(`${v.file}:${v.line}\t${v.token}\t${v.snippet}`);
    console.log(`\n共 ${violations.length} 处（仅列不判）`);
    process.exit(0);
}
if (violations.length > 0) {
    console.error(`✗ OS 边界被越过：${violations.length} 处（系统假设只许出现在 src/main/os/）\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.token}  ${v.snippet}`);
    console.error(`\n处置：改调 main/os 的 os.*；确需在本文件特判的写「// os-boundary-ok: <理由>」。`);
    process.exit(1);
}
console.log("[check-os-boundary] ✓ 通过：系统假设仅存在于 src/main/os/");
