// tools/index.ts —— 房间的工具装配。
//
// 给一个房间配上 read / write / edit / bash，cwd = 房间目录；
// 再挂一个 `ask`：需要用户做决定时，把选项 / 表单推到界面上。
//
// 工具实现是本包内的精简移植（见 files.ts / shell.ts 的头注）。

import type { ToolSet } from 'ai';

import type { AskGate } from '../ask';
import { askTool } from './ask';
import { editTool, readTool, writeTool } from './files';
import { bashTool } from './shell';

export { clipModelMessage, clipToolOutput, DEFAULT_CLIP, type ClipPolicy } from './clip';

export interface RoomToolsOptions {
    /** 房间的工作目录（相对路径的解析基准，也是命令的 cwd） */
    cwd: string;
    /** 是否开放 shell；缺省开放 */
    shell?: boolean;
    /** shell 缺省超时（毫秒）；0 = 不设超时 */
    bashTimeoutMs?: number;
    /** 提问闸门；不传 = 没有 ask 工具 */
    ask?: AskGate;
    /** 提问的归属成员（按成员停止时只取消他家的提问） */
    askOwner?: string;
}

/** 给一个房间装配工具集 */
export function buildRoomTools(options: RoomToolsOptions): ToolSet {
    const tools: ToolSet = {
        read: readTool(options.cwd),
        write: writeTool(options.cwd),
        edit: editTool(options.cwd),
    };
    if (options.shell !== false) tools['bash'] = bashTool(options.cwd, options.bashTimeoutMs ?? 120_000);
    const ask = askTool(options.ask, options.askOwner);
    if (ask !== undefined) tools['ask'] = ask;
    return tools;
}
