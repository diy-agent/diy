// @diy-agent/tools/src/shell/detect.ts — shell 能力的**探测**（候选清单的真源）
//
// 为什么在包里（##515 第 2 步）：bot / CLI 这类宿主**没有 os 策略层**，但同样需要「本机有哪些
// shell 能力」。探测逻辑原先在 `apps/diy-app/src/main/os/win32.ts`（`discoverShellSpecs` 等），
// 搬到这里做**唯一真源** —— diy-app 改为从这里 import + 重导出（单测 import 路径不变），
// 别在两处各写一份候选清单（两份必然漂）。
//
// 边界：本文件只做「看平台 / 看安装位置」这一件事（`process.platform` / `existsSync` /
// `DIY_SHELL`），不跑进程、不拼命令 —— 命令拼装在 spec.ts，执行在 run.ts。
// `diy-app` 侧仍遵守它的 R 规则：那边只调 `os.*`，不直接看平台（见 os/README.md）。

import { existsSync } from "node:fs";
import { win32 as winPath } from "node:path";
import type { ShellSpec } from "./spec.js";

/** 按可执行文件名判定能力种类（bash/sh vs pwsh/powershell）。 */
function shellKindOf(file: string): "bash" | "pwsh" {
    return /(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/i.test(file) ? "bash" : "pwsh";
}

/**
 * Windows 上 bash 的候选（`DIY_SHELL` → Git Bash 已知位置 → PATH）。
 *
 * System32 里的 `bash.exe` 是 WSL 启动桩（语义不同），**不自动用**。
 */
export function winShellCandidates(env: NodeJS.ProcessEnv): string[] {
    const out: string[] = [];
    const add = (p: string | undefined): void => {
        if (p && p.trim()) out.push(p);
    };
    add(env["DIY_SHELL"]);
    const gitBin = (...root: Array<string | undefined>): string | undefined => {
        const base = root.filter((x): x is string => Boolean(x)).join("\\");
        return base ? winPath.join(base, "Git", "bin", "bash.exe") : undefined;
    };
    add(gitBin(env["ProgramFiles"]));
    add(gitBin(env["ProgramW6432"]));
    add(gitBin(env["ProgramFiles(x86)"]));
    add(env["LOCALAPPDATA"] ? winPath.join(env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe") : undefined);
    add(
        env["USERPROFILE"]
            ? winPath.join(env["USERPROFILE"], "scoop", "apps", "git", "current", "bin", "bash.exe")
            : undefined,
    );
    for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
        const d = dir.trim().replace(/^"|"$/g, "");
        // System32 里的 bash.exe 是 WSL 启动桩，语义不同，不自动用
        if (!d || /[\\/]system32[\\/]?$/i.test(d) || /[\\/]syswow64[\\/]?$/i.test(d)) continue;
        add(winPath.join(d, "bash.exe"));
    }
    return [...new Set(out)];
}

/** Windows 上 pwsh 的候选（优先 PowerShell 7，最后才是 5.1）。 */
export function pwshCandidates(env: NodeJS.ProcessEnv): string[] {
    const out: string[] = [];
    const add = (p: string | undefined): void => {
        if (p && p.trim()) out.push(p);
    };
    for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
        const d = dir.trim().replace(/^"|"$/g, "");
        if (!d) continue;
        add(winPath.join(d, "pwsh.exe"));
    }
    add(env["ProgramFiles"] ? winPath.join(env["ProgramFiles"], "PowerShell", "7", "pwsh.exe") : undefined);
    add(
        env["SystemRoot"]
            ? winPath.join(env["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
            : undefined,
    );
    for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
        const d = dir.trim().replace(/^"|"$/g, "");
        if (!d) continue;
        add(winPath.join(d, "powershell.exe"));
    }
    return [...new Set(out)];
}

/**
 * Windows 的 shell 能力探测（R6/R7）：`DIY_SHELL` → Git Bash 已知位置 → `pwsh.exe` → `powershell.exe`。
 * **bash 缺席不是错误** —— 有 pwsh 就够用；两者都有时都返回（工具面并存）。
 */
export function discoverShellSpecs(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): ShellSpec[] {
    const diy = (env["DIY_SHELL"] ?? "").trim();
    // 显式 DIY_SHELL 是**权威覆盖**：设了（哪怕指错）就不再猜 Git Bash ——
    // 这样「把 bash 关掉看 pwsh 降级」是可复现的，而不是"指错也照样找到 Git Bash"。
    const bashList = diy ? [diy] : winShellCandidates(env);
    const tried = [...bashList, ...pwshCandidates(env)];
    const out: ShellSpec[] = [];
    const seen = new Set<string>();
    for (const file of tried) {
        const key = file.toLowerCase();
        if (seen.has(key) || !exists(file)) continue;
        seen.add(key);
        out.push({ kind: shellKindOf(file), file, label: file, missing: false, tried });
    }
    return out;
}

/**
 * POSIX 的 shell 能力（`DIY_SHELL` 覆盖 → `/bin/bash`）。
 *
 * 与 diy-app 的 posix 策略同口径：`/bin/bash` 一定存在（macOS / Linux 都是），
 * 所以不做存在性检查 —— 真缺了会在 spawn 时报「命令未能启动」（③ 档），比这里猜更诚实。
 */
export function posixShellSpecs(env: NodeJS.ProcessEnv = process.env): ShellSpec[] {
    const diy = (env["DIY_SHELL"] ?? "").trim();
    const file = diy || "/bin/bash";
    return [{ kind: shellKindOf(file), file, label: file, missing: false, tried: [file] }];
}

/** 探测依赖（单测注入；缺省读真环境） */
export interface DetectDeps {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?(path: string): boolean;
}

/**
 * 本机可用的 shell 能力（首选在前）。**没有 os 策略层的宿主**（bot / CLI）用它；
 * diy-app 走自己的 `os.resolveShells()`（那边还要考虑 caps 与策略覆盖）。
 */
export function detectShells(deps: DetectDeps = {}): ShellSpec[] {
    const platform = deps.platform ?? process.platform;
    const env = deps.env ?? process.env;
    if (platform !== "win32") return posixShellSpecs(env);
    return discoverShellSpecs(env, deps.exists ?? existsSync);
}

/** 首选能力（`detectShells()[0]`；都没有时给一个 `missing` 哨兵，供错误文案使用）。 */
export function detectPreferredShell(deps: DetectDeps = {}): ShellSpec {
    return (
        detectShells(deps)[0] ?? {
            kind: "bash",
            file: "bash",
            label: "bash",
            missing: true,
            tried: [],
        }
    );
}
