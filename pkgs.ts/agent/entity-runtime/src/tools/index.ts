// tools/index.ts —— 房间的工具装配。
//
// 给一个房间配上 read / write / edit / bash，cwd = 房间目录。
// 工具实现是本包内的精简移植（见 files.ts / shell.ts 的头注）。

import type { ToolSet } from 'ai';

import { editTool, readTool, writeTool } from './files';
import { bashTool } from './shell';

export interface RoomToolsOptions {
    /** 房间的工作目录（相对路径的解析基准，也是命令的 cwd） */
    cwd: string;
    /** 是否开放 shell；缺省开放 */
    shell?: boolean;
    /** shell 缺省超时（毫秒）；0 = 不设超时 */
    bashTimeoutMs?: number;
}

/** 给一个房间装配工具集 */
export function buildRoomTools(options: RoomToolsOptions): ToolSet {
    const tools: ToolSet = {
        read: readTool(options.cwd),
        write: writeTool(options.cwd),
        edit: editTool(options.cwd),
    };
    if (options.shell !== false) tools['bash'] = bashTool(options.cwd, options.bashTimeoutMs ?? 120_000);
    return tools;
}
