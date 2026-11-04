// 🎯 shell 能力的**探测缓存**（OS 策略 + 进程内缓存）
//
// 探测本身在策略里（POSIX 固定 /bin/bash；Windows 试 Git Bash → pwsh → powershell）。
// 这里只缓存一次 —— shell 路径不会变。
//
// 命令拼装（`buildInvocation`）与工具名（`shellToolName`）已搬到 `@diy-agent/tools`（##515 第 1 步）：
// 那是工具语义，任何宿主（bot / diy-app）都该用同一份。本文件只留"看平台/看安装位置"的那一半，
// 并原样再导出，免得调用方各记一套 import。

import { os } from "./index.js";
import type { ShellSpec } from "./types.js";

export { buildInvocation, noShellHint, shellToolName } from "@diy-agent/tools";
export type { Invocation } from "@diy-agent/tools";

let cached: ShellSpec[] | undefined;

/** 本机可用的 shell 能力（首选在前）。进程内缓存 —— shell 路径不会变。 */
export function shellSpecs(): ShellSpec[] {
    cached ??= os.resolveShells();
    return cached;
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
