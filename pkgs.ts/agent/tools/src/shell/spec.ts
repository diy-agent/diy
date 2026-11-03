// @diy-agent/tools/src/shell/spec.ts — shell **能力的事实与命令拼装**（纯函数，不探测）
//
// 从 apps/diy-app/src/main/os/shell.ts 搬来（##515 第 1 步）：`buildInvocation` / `shellToolName` /
// `noShellHint` / `ShellSpec` / `Invocation` 全部逐字保留，**只把"探测"留在宿主**
// （探测要看平台与安装位置 —— 那是 OS 策略，宿主自己调 `os.resolveShells()` 传进来）。
//
// 判据：本文件不许出现 process.platform / 子进程 / 文件系统 —— 它只把「一条命令」翻译成
// 「某个已探测到的能力怎么调」（R8）。

/** 一次 shell 能力探测的结果（bash / pwsh 是**两种能力**，语法与退出码语义都不同）。 */
export interface ShellSpec {
    /** 能力种类：决定工具名（`bash` / `pwsh`）与命令拼装方式 */
    kind: "bash" | "pwsh";
    /** 可执行文件路径 */
    file: string;
    /** 给人看的名字（错误文案里用） */
    label: string;
    /** 本平台确实没找到这个能力 */
    missing: boolean;
    /** 找过哪些位置（`missing` 时写进错误文案） */
    tried: string[];
}

export interface Invocation {
    file: string;
    args: string[];
}

/**
 * 包内**兜底**能力：宿主正常应显式传 `shell`（探测是宿主的事）。
 *
 * 只用于「没传就调 runBash」的场合（单测 / 临时脚本）：`bash` 走 PATH 解析，
 * 找不到就是 spawn 失败（③ 档），不在这里猜绝对路径。
 */
export const FALLBACK_SHELL: ShellSpec = {
    kind: "bash",
    file: "bash",
    label: "bash",
    missing: false,
    tried: [],
};

/** 工具名（L1 不写 "bash"/"pwsh" 字面量，避免把机制词散回业务层）。 */
export function shellToolName(spec: ShellSpec): "bash" | "pwsh" {
    return spec.kind === "bash" ? "bash" : "pwsh";
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

/**
 * shell 能力缺失时的**事实句**（不是「去装 Git Bash」的劝告）。
 *
 * 用户 2026-10-31 裁定：bash 与 pwsh 是两种能力；没有 bash 不是错误，降级到 pwsh 即可。
 * 只有当**两种都没有**时才需要这条文案（正常 Windows 一定有 powershell.exe）。
 */
export function noShellHint(specs: readonly ShellSpec[]): string {
    const tried = specs.flatMap((s) => s.tried);
    return (
        "本机没有可用的命令 shell（bash 与 PowerShell 都探测不到）。" +
        (tried.length > 0 ? `已尝试：${[...new Set(tried)].join("；")}` : "")
    );
}
