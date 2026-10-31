// 🎯 shell 能力的缓存与命令拼装（OS 无关的部分）
//
// 探测本身在策略里（POSIX 固定 /bin/bash；Windows 试 Git Bash → pwsh → powershell）。
// 这里只缓存一次，并负责把「一条命令」翻译成各能力的调用形状（R8）。

import { os } from "./index";
import type { ShellSpec } from "./types";

let cached: ShellSpec[] | undefined;

/** 本机可用的 shell 能力（首选在前）。进程内缓存 —— shell 路径不会变。 */
export function shellSpecs(): ShellSpec[] {
    cached ??= os.resolveShells();
    return cached;
}

/** 工具名（L1 不写 "bash"/"pwsh" 字面量，避免把机制词散回业务层）。 */
export function shellToolName(spec: ShellSpec): "bash" | "pwsh" {
    return spec.kind === "bash" ? "bash" : "pwsh";
}

/** 首选能力（`shellSpecs()[0]`；都没有时给一个 `missing` 哨兵，供错误文案使用）。 */
export function preferredShell(): ShellSpec {
    return (
        shellSpecs()[0] ?? {
            kind: "bash",
            file: "bash",
            label: "bash",
            missing: true,
            tried: [],
        }
    );
}

/** 仅测试用：丢掉缓存。 */
export function resetShellForTest(): void {
    cached = undefined;
}

export interface Invocation {
    file: string;
    args: string[];
}

/** PowerShell 输出前置：强制 UTF-8（中文路径/输出不按 OEM 码页乱码）。 */
const PS_UTF8 =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";

/** POSIX shell 单引号转义。 */
function shQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/** PowerShell 单引号字符串转义（单引号自身翻倍）。 */
function psQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 把命令翻译成实际调用形状（R8）。
 *
 * - `bash`：`bash -c <command>`；带日志时先 `exec >> log 2>&1`（Git Bash 会吞 Node 传入的 fd）。
 * - `pwsh`：`-NoProfile -NonInteractive -Command`，前置 UTF-8；**退出码透传**
 *   （`& { <cmd> }; exit $LASTEXITCODE`）；含换行时改 `-EncodedCommand`（UTF-16LE base64）。
 *   `pwsh` 没有 MSYS 的句柄问题，日志用 PowerShell 的 `*>>` 重定向。
 */
export function buildInvocation(spec: ShellSpec, command: string, logPath?: string): Invocation {
    if (spec.kind === "bash") {
        const redirect = logPath ? `exec >> ${shQuote(logPath.replace(/\\/g, "/"))} 2>&1; ` : "";
        return { file: spec.file, args: ["-c", `${redirect}${command}`] };
    }
    // PowerShell 5.1 的 `*>>` 写 UTF-16；统一走 Out-File -Encoding utf8（日志读侧是 utf8）。
    const redirect = logPath ? ` *>&1 | Out-File -FilePath ${psQuote(logPath)} -Append -Encoding utf8` : "";
    const script = `${PS_UTF8}& { ${command} }${redirect}; exit $LASTEXITCODE`;
    if (script.includes("\n")) {
        return {
            file: spec.file,
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(script, "utf16le").toString("base64"),
            ],
        };
    }
    return { file: spec.file, args: ["-NoProfile", "-NonInteractive", "-Command", script] };
}
