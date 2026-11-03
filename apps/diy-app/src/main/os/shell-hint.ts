// 🎯 shell 能力的**事实句**（不是「去装 Git Bash」的劝告）
//
// 用户 2026-10-31 裁定：bash 与 pwsh 是两种能力；没有 bash 不是错误，降级到 pwsh 即可。
// 只有当**两种都没有**时才需要这条文案（正常 Windows 一定有 powershell.exe）。

import type { ShellSpec } from "./types";

export function noShellHint(specs: readonly ShellSpec[]): string {
    const tried = specs.flatMap((s) => s.tried);
    return (
        "本机没有可用的命令 shell（bash 与 PowerShell 都探测不到）。" +
        (tried.length > 0 ? `已尝试：${[...new Set(tried)].join("；")}` : "")
    );
}
