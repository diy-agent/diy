// src/main/services/warm-wait.ts
// 🎯 冷缓存等待的**装配层**（##486）：读开关 → 问判据 → 真睡 → 回报实等的毫秒数。
//
// 分工（与 cache-hint / env-watch 同构）：
//   · 判据 = `shared/warm-wait.ts`（纯函数：全冷口径 / 小请求闸门 / 开关）
//   · 本文件只管「读环境变量 + 真睡」，不做任何口径判断
//
// 调用点（唯一）= local-agent 的 `prepareStep`：每个模型请求发出前一次。
//   · 之所以放 prepareStep 而不是「streamText 之前」：轮内后续步也各有一次真发，
//     上一步刚全冷时那一步同样赶在缓存落位前（3.5% 的样本里大半是这类相邻步）。
//   · 正常路径**零延迟**：判据说不等就一次 `setTimeout` 都不排（判据 2 的硬要求）。
//
// 记账（判据 4 的数据来源）：等过的那一步在 `usage.jsonl` 里带 `waitedMs`；
// 缺席 = 没等。事后用「有 waitedMs 的步 → 下一步的缓存读」算等待组的再全冷率，
// 与历史基线 3.5% 对比即可。

import { decideWarmWait, type WarmWaitDecision } from "../../shared/warm-wait";

/** 环境开关（压测 / 测试用）：`DIY_NO_WARM_WAIT=1` ⇒ 一律不等 */
export function warmWaitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env["DIY_NO_WARM_WAIT"] !== "1";
}

export interface WarmWaitOutcome extends WarmWaitDecision {
    /** 实际等掉的毫秒数（= `waitMs`；不等则为 0）。调用点据此写 `usage.jsonl` 的 `waitedMs` */
    waitedMs: number;
}

/**
 * 上一步全冷 ⇒ 等 1 秒；否则**立刻**返回（不排定时器、不 await 任何东西的等待）。
 *
 * `sleep` 可注入（单测不真睡）；`signal` 可注入（用户中止这一轮时不必空等完那 1 秒）。
 */
export async function warmWaitIfCold(
    last: { cacheRead: number; inputTotal: number } | null,
    opts: {
        enabled?: boolean;
        waitMs?: number;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
        signal?: AbortSignal;
    } = {},
): Promise<WarmWaitOutcome> {
    const decision = decideWarmWait({
        enabled: opts.enabled ?? warmWaitEnabled(),
        last,
        ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
    });
    if (decision.waitMs <= 0) return { ...decision, waitedMs: 0 };
    await (opts.sleep ?? abortableSleep)(decision.waitMs, opts.signal);
    return { ...decision, waitedMs: decision.waitMs };
}

/** 可中止的 sleep：中止信号到达即提前返回（不抛 —— 等待只是延迟，不是这一步的失败） */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
    });
}
