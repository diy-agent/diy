// src/shared/warm-wait.ts
// 🎯 冷缓存等待的**判据**（##486）：上一步全冷 ⇒ 这一步真发前等 1 秒。
//
// 为什么要有这一刀（用户裁决 2026-10-30，本机实测）：
//   上一步全冷 → 这一步零缓存 = 3.5%（n=289）
//   上一步正常 → 这一步零缓存 = 0.8%（n=39961）
// 差 4.4 倍 ⇒ 上游前缀缓存**不是发出即生效**的，前一步刚全冷时后一步赶在缓存落位前发出，
// 就会再全冷一次；而一次全冷请求的费用是有缓存时的几十倍。等 1 秒买的是「缓存已落位」。
//
// 口径（**别自己改**，改了判据 4 的对比就失去意义）：
//   · 「上一步全冷」= `cacheRead / inputTokens < 0.05` 且 `inputTokens > 50000`
//   · 小请求（≤ 50000 输入）不启用：缓存收益本来就小，等 1 秒只会让测试和短对话变慢
//   · 没有上一步（进程刚起 / 新任务首轮）⇒ 不等 —— 首次请求不存在「前一步没落缓存」
//
// 本文件是**纯函数、零 IO、零 node 依赖**：只回答「等不等、等多久」。
// 真睡与开关在 `main/services/warm-wait.ts`，调用点只有一个（local-agent 的 prepareStep）。

/** 等待时长（用户定稿：最少 1 秒，先看 1 秒的效果；不做退避、不做 3 秒） */
export const WARM_WAIT_MS = 1000;

/** 「全冷」的缓存读占比上限（严格小于才算全冷） */
export const COLD_CACHE_RATIO_MAX = 0.05;

/** 小请求阈值：输入 ≤ 这个数一律不等（避免测试变慢） */
export const COLD_MIN_INPUT_TOKENS = 50_000;

/** 没等的原因（`null` = 等了，即上一步全冷） */
export type WarmWaitSkipReason = "disabled" | "no-previous" | "small-request" | "warm";

export interface WarmWaitDecision {
    /** 该睡的毫秒数（0 = 不等）—— 正常路径恒为 0（判据 2：不引入普遍延迟） */
    waitMs: number;
    /** 上一步的缓存读占比（null = 没有上一步 / 输入为 0）；供日志与事后核对 */
    lastCacheRatio: number | null;
    /** 没等的原因；`null` = 等了 */
    skip: WarmWaitSkipReason | null;
}

/**
 * 判断这一步要不要等 —— **唯一实现**（装配层与单测共用，别在调用点重写不等式）。
 *
 * `last` = 上一步的 `{cacheRead, inputTotal}`（桶口径，与 `usage.jsonl` 的
 * `inputTokenDetails.cacheReadTokens` / `inputTokens` 同源）。
 */
export function decideWarmWait(input: {
    /** 开关（`DIY_NO_WARM_WAIT=1` ⇒ false）；关掉时连判据都不算，一律不等 */
    enabled: boolean;
    /** 上一步的缓存读 / 总输入；null = 没有上一步 */
    last: { cacheRead: number; inputTotal: number } | null;
    /** 覆盖等待时长（单测用；生产不传） */
    waitMs?: number;
}): WarmWaitDecision {
    const waitMs = input.waitMs ?? WARM_WAIT_MS;
    const last = input.last;
    const ratio = last && last.inputTotal > 0 ? last.cacheRead / last.inputTotal : null;
    if (!input.enabled) return { waitMs: 0, lastCacheRatio: ratio, skip: "disabled" };
    if (last === null || ratio === null) return { waitMs: 0, lastCacheRatio: null, skip: "no-previous" };
    if (last.inputTotal <= COLD_MIN_INPUT_TOKENS) return { waitMs: 0, lastCacheRatio: ratio, skip: "small-request" };
    if (ratio >= COLD_CACHE_RATIO_MAX) return { waitMs: 0, lastCacheRatio: ratio, skip: "warm" };
    return { waitMs, lastCacheRatio: ratio, skip: null };
}

/** 上一步是不是「全冷」（只管口径，不管开关与阈值）—— 观察位用；判据仍以 decideWarmWait 为准 */
export function isColdStep(last: { cacheRead: number; inputTotal: number } | null): boolean {
    if (!last || last.inputTotal <= 0) return false;
    return last.cacheRead / last.inputTotal < COLD_CACHE_RATIO_MAX;
}
