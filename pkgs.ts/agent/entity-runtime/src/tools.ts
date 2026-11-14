// tools.ts —— 房间的工具装配。
//
// 工具内核在 `@diy-agent/tools`（read / write / edit + bash/pwsh），这里只做"从房间到工具"的接线：
//   · cwd = 房间目录（项目目录，或任务继承来的项目目录）
//   · 审计只打日志（宿主决定写去哪；diy2 暂时没有审计账本）
//   · bash 可以用 `DIY2_TOOLS=files` 关掉，只留文件工具
//
// 不在这里做的事：权限策略、工具配额、后台作业（job）—— 那些等真实需要再加。

import { buildTools, detectPreferredShell, makeShellTool, shellToolName } from '@diy-agent/tools';
import type { ToolSet } from 'ai';

export interface RoomToolsOptions {
    /** 房间的工作目录（相对路径的解析基准，也是命令的 cwd） */
    cwd: string;
    /** 是否开放 shell；缺省开放 */
    shell?: boolean;
    /** shell 缺省超时（毫秒）；0 = 不设超时 */
    bashTimeoutMs?: number;
    onAudit?: (event: { phase: string; command?: string; path?: string; result?: string }) => void;
}

/** 给一个房间装配工具集：read / write / edit（+ bash） */
export function buildRoomTools(options: RoomToolsOptions): ToolSet {
    const extra: ToolSet = {};
    if (options.shell !== false) {
        const spec = detectPreferredShell();
        if (!spec.missing) {
            extra[shellToolName(spec)] = makeShellTool(spec, {
                cwd: options.cwd,
                limits: { bashTimeoutMs: options.bashTimeoutMs ?? 120_000 },
            });
        }
    }
    return buildTools({
        cwd: options.cwd,
        extraTools: extra,
        ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
    });
}
