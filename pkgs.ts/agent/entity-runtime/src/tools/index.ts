// tools/index.ts —— 房间的工具装配。
//
// 给一个房间配上 read / write / edit / bash，cwd = 房间目录。
// 写文件与执行命令要人点头（approve）；read 不需要。
//
// 工具实现是本包内的精简移植（见 files.ts / shell.ts 的头注）。

import type { ToolSet } from 'ai';

import type { ApprovalDecision } from '../approval';
import { editTool, readTool, writeTool, type Guard } from './files';
import { bashTool } from './shell';

export { clipModelMessage, clipToolOutput, DEFAULT_CLIP, type ClipPolicy } from './clip';

export interface RoomToolsOptions {
    /** 房间的工作目录（相对路径的解析基准，也是命令的 cwd） */
    cwd: string;
    /** 是否开放 shell；缺省开放 */
    shell?: boolean;
    /** shell 缺省超时（毫秒）；0 = 不设超时 */
    bashTimeoutMs?: number;
    /** 审批：传了就每个写/执行工具先等一个决定；不传 = 不审批 */
    approve?: (input: { toolName: string; args?: Record<string, unknown> }) => Promise<ApprovalDecision>;
}

/** 给一个房间装配工具集 */
export function buildRoomTools(options: RoomToolsOptions): ToolSet {
    const approve = options.approve;
    const guardOf = (toolName: string): Guard | undefined =>
        approve === undefined
            ? undefined
            : (async (args: Record<string, unknown>) => {
                  const decision = await approve({ toolName, args });
                  if (!decision.approved) {
                      throw new Error(
                          `【已拒绝】用户没有批准 ${toolName}${decision.reason === undefined ? '' : `（${decision.reason}）`}`,
                      );
                  }
              }) as Guard;

    const writeGuard = guardOf('write');
    const editGuard = guardOf('edit');
    const bashGuard = guardOf('bash');

    const tools: ToolSet = {
        read: readTool(options.cwd),
        write: writeTool(options.cwd, writeGuard),
        edit: editTool(options.cwd, editGuard),
    };
    if (options.shell !== false) {
        tools['bash'] = bashTool(options.cwd, options.bashTimeoutMs ?? 120_000, bashGuard);
    }
    return tools;
}
