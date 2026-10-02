// src/main/services/turn-usage.ts
// 🎯 一轮（turn）的 usage 账本：**唯一**的口径定义处（纯函数，可单测）。
//
// 为什么单独一个文件：usage 有三个来源（每步 finish-step / 流尾 finish.totalUsage / 都没有），
// 而"缓存命中"是 ##140 的验收指标、也是 ##148 划分策略是否省钱的唯一硬证据 ——
// 口径散在 runTurn 的 switch 里就只能靠端到端测试碰运气（209 review C-7 的教训：
// 曾经连字段都没采集，于是"省了多少钱"谁都答不出）。
//
// 字段来源（实测，2026-10-02）：
//   usage.inputTokenDetails.cacheReadTokens ← provider 的 prompt_tokens_details.cached_tokens
//   ⚠️ **不是** providerMetadata：zen/go 实测 providerMetadata 恒为 `{"zen-go":{}}`（空对象），
//   按它取缓存字段永远拿不到数（209 里记的修法方向是错的，见任务 220 的回应章节）。

/** AI SDK `LanguageModelUsage` 的窄子集（part 是 unknown，这里只窄出我们读的字段） */
export interface TurnUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: {
        noCacheTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
}

/** 一轮的 usage 账本（`cached` = 命中前缀缓存的输入 tokens） */
export interface UsageAcc {
    in: number;
    out: number;
    /** 命中前缀缓存的输入 tokens（暖输入）；0 = 这一步/这一轮整个输入都按全价算 */
    cached: number;
    total: number;
}

export function newUsageAcc(): UsageAcc {
    return { in: 0, out: 0, cached: 0, total: 0 };
}

/**
 * 累加**一步**的 usage（finish-step 用）。
 * 文档语义：多步时整轮 usage = 各步之和（ai@7 `LanguageModelUsage` 注释），
 * 所以"逐块累加"与"流尾总量"同口径 —— 两者只差"谁更权威"。
 */
export function addStepUsage(acc: UsageAcc, u: TurnUsage | undefined): UsageAcc {
    if (!u) return acc;
    acc.in += u.inputTokens ?? 0;
    acc.out += u.outputTokens ?? 0;
    acc.cached += u.inputTokenDetails?.cacheReadTokens ?? 0;
    acc.total += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    return acc;
}

/**
 * 用**流尾权威值**覆盖整轮账本（finish 用）；字段缺失时保留累加值。
 * 为什么不新增字段：totalUsage 的语义就是"各步之和"（同上），覆盖不改变口径，
 * 只是把"流尾偶发缺失"时的累加值换成权威值。
 */
export function setTurnUsage(acc: UsageAcc, u: TurnUsage | undefined): UsageAcc {
    if (!u) return acc;
    acc.in = u.inputTokens ?? acc.in;
    acc.out = u.outputTokens ?? acc.out;
    acc.cached = u.inputTokenDetails?.cacheReadTokens ?? acc.cached;
    acc.total = u.totalTokens ?? acc.in + acc.out;
    return acc;
}

/** 缓存命中率（0~1）；输入为 0 时返回 0（而不是 NaN） */
export function cacheHitRate(acc: Pick<UsageAcc, "in" | "cached">): number {
    return acc.in > 0 ? acc.cached / acc.in : 0;
}
