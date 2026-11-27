// index.ts —— code-runtime 的出口：契约 + 引擎实现。
//
// 两个入口：
//   · `.`            契约（`CodeRuntime` / `RunOptions` / `RunResult`）+ 默认引擎
//   · `./in-process` 显式拿 `InProcessVmRuntime`（要传自定义 `RunLimits` 时用这个）

export {
    DEFAULT_LIMITS,
    type CodeRuntime,
    type LogEntry,
    type RunLimits,
    type RunOptions,
    type RunResult,
} from './types.js';
export { InProcessVmRuntime } from './in-process.js';
export { formatApiHelp, makeGlobals, type ApiHelpItem, type GlobalsOptions } from './globals.js';
export { apiHelpOf } from './api-help.js';

import { InProcessVmRuntime } from './in-process.js';

/**
 * 本机默认引擎。
 *
 * 为什么先给进程内：它没有启动成本，且能把 typed RPC client（Proxy）直接注入 ——
 * 子进程 / worker 都得先在那边重建 client。等真出现"杀不掉的死循环"或"内存被打爆"，
 * 换实现即可，`globals` 契约不动。
 */
export const defaultCodeRuntime = new InProcessVmRuntime();
