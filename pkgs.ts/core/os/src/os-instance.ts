// os-instance.ts — OS 策略单例（从 index.ts 抽出来，避免 process-sampler 反向依赖 index 成环）
//
// 规则不变：**全仓唯一**允许看 `process.platform` 的地方就是这里（原来在 index.ts）。
import { createPosixOs } from "./posix.js";
import { createWin32Os } from "./win32.js";
import type { OsStrategy } from "./types.js";

/**
 * 平台选型（唯一按平台**选型**的地方）。
 *
 * `DIY_OS_STRATEGY=posix|win32` 只给 CI 冒烟 / 排障用：非法值**不崩**（模块初始化抛错会连
 * 配置 UI 都起不来），warn 后回落平台事实。
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
