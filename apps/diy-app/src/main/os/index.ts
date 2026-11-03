// 🎯 OS 策略选型 —— **全仓唯一**允许看 `process.platform` 的地方
//
// 规则（用户 2026-10-31 定）：非此文件的代码不许出现平台分支；需要系统能力就调 `os.*`。
// 想加新平台/新能力：在这里选型 + 在 posix.ts / win32.ts 各实现一次（或声明 caps 不支持）。

import { createPosixOs } from "./posix";
import { createWin32Os } from "./win32";
import type { OsStrategy } from "./types";

/**
 * 平台选型（唯一按平台**选型**的地方）。
 *
 * `DIY_OS_STRATEGY=posix|win32` 只给 CI 冒烟 / 排障用：非法值**不崩**（模块初始化抛错会连
 * 配置 UI 都起不来），warn 后回落平台事实。它不是一个可配置的「部署选项」——
 * OS 是运行环境事实，配错只会产生「在 Windows 上跑 posix 策略」这种运行时假象。
 */
export function osKindOf(raw: string | undefined, platform: NodeJS.Platform = process.platform): "posix" | "win32" {
    if (raw === "posix" || raw === "win32") return raw;
    if (raw !== undefined && raw.trim() !== "") {
        console.warn(`[os] 忽略非法 DIY_OS_STRATEGY=${JSON.stringify(raw)}（只认 posix / win32），按平台 ${platform} 选型`);
    }
    return platform === "win32" ? "win32" : "posix";
}

/** 本进程生效的 OS 策略（单例；无状态，可安全共享）。 */
export const os: OsStrategy = osKindOf(process.env["DIY_OS_STRATEGY"]) === "win32" ? createWin32Os() : createPosixOs();

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
} from "./types";
export { formatEtime, parseEtime } from "./duration";
