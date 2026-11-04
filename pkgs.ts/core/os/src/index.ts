// index.ts — @diy-agent/os 的入口
//
// 规则（用户 2026-10-31 定）：**全仓唯一**允许看 `process.platform` 的地方是
// `os-instance.ts`；非此模块的代码不许出现平台分支，需要系统能力就调 `os.*`。
// 想加新平台/新能力：在 os-instance 选型 + 在 posix.ts / win32.ts 各实现一次
// （或声明 caps 不支持）。

export { os, osKindOf } from "./os-instance.js";

export type {
    GpuInfo,
    OsCapabilities,
    OsStrategy,
    OwnQuery,
    OwnedSnapshot,
    ProcessHop,
    ProcessProbe,
    ProcessRow,
    ProcessTree,
    ShellSpec,
} from "./types.js";

export { formatEtime, parseEtime } from "./duration.js";
export * from "./shell.js";
export * from "./shell-hint.js";
export * from "./live.js";
export * from "./tree.js";
export * from "./proc-scan.js";
export * from "./process-health.js";
export * from "./process-sampler.js";
export * from "./rm.js";
export * from "./fs-lock.js";
