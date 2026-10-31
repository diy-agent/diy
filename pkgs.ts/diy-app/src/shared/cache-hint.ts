// src/shared/cache-hint.ts
// 🎯 冷缓存提示的**唯一判据**（##477；纯函数，禁止 import node:*）
//
// ── 要解决的问题（用户 2026-10-30 口径）──
// 距上次请求太久，上游的提示词缓存已经过期 —— 这一轮整段上下文要**按全价重付**。
// 这个事实原本完全沉默：用户只看到「这轮怎么这么贵」，agent 也不知道该不该建议换模型。
// 本文件只回答两件事：**边界在哪**（safePoint / failPoint）与**该不该提示**。
//
// ── 两个数（维度 = provider × model，**不是 model**；实测同模型不同渠道差 12 倍：
//    opencode-go 15–30min 命中 6.8%，直连 deepseek 81.8%）──
//   · safePoint（安全点）：最近 N=100 次**首步成功**请求的 gap 的 **P90**。
//     成功判据 = `cacheRead / inputTokens > 0.9`（真命中，不是"有读就算"）。
//     无历史 → 60s（保护值：刚起来的实例没有历史，不能一上来就沉默）。
//   · failPoint（失效点）：首步 **hitRate ≈ 0** 的那次 gap，**只降不升**（更严格的方向）。
//     无历史 → +∞（不知道就不限制：没有失败证据时不猜一个数）。
//     ⚠️ 只收紧**越过安全区**的失败：gap ≤ safePoint 的失败是上游抖动 / 前缀变了，
//     不是"缓存活不过这么久" ⇒ 忽略（用户 10-30：不然提示就过多了）。
//
// ── 提示规则（为什么用 max，而不是只比 failPoint）──
//   `if (isFirstStep && gap > 60s && gap > max(safePoint, failPoint)) → 提示`
//   **safePoint 优先**：若 failPoint=10min 但 safePoint 已升到 11min，说明有更多成功案例
//   支持更长安全期，那 10min 那次失败更可能是异常 ⇒ **不提示**。failPoint 仍照实记录
//   （那是事实），只是不触发提示。
//   failPoint=+∞ 时 max 也是 +∞ ⇒ **永不提示** —— 与「无历史不提示」是同一条规则的两面。
//
// ── 不做（用户明确）──
//   · 不自动压缩（压缩汇总还没做好，自动压会失忆）
//   · 不改压缩触发线（那是 shared/context/cache-ttl.ts 的夹逼口径，两件事）
//   · 不做跨 app 汇总（本 app 的 store 就够）

import { z } from "zod";

/** 无历史时的 safePoint：60s（刚起来的实例没有历史就靠它） */
export const SAFE_POINT_DEFAULT_MS = 60_000;
/** safePoint 的滚动窗口：最近 N 次首步成功请求的 gap */
export const SAFE_POINT_WINDOW = 100;
/** 成功判据：`cacheRead / inputTokens >` 它（真命中） */
export const CACHE_HIT_SUCCESS = 0.9;
/** 失败判据：`cacheRead / inputTokens <` 它（≈ 0，整段输入按全价算） */
export const CACHE_HIT_MISS = 0.05;
/** 提示的下限门槛：小于它连算都不用算（短间隔本来就不可能冷） */
export const HINT_MIN_GAP_MS = 60_000;

/**
 * 一个渠道（provider × model）的统计。
 *
 * `safePoint` 是 `samples` 的**投影**（写盘时一并落，便于人读与判据 1 的核对），
 * 读回时以 samples 重算为准 —— 手工改 projection 不该改变行为。
 */
export interface ChannelStats {
    /** 安全点（ms）：samples 的 P90；无 samples = {@link SAFE_POINT_DEFAULT_MS} */
    safePoint: number;
    /** 失效点（ms）：观察到的最小"首步全未命中"gap；null = +∞（无失败证据） */
    failPoint: number | null;
    /** 最近 {@link SAFE_POINT_WINDOW} 次首步成功请求的 gap（ms，时间正序） */
    samples: number[];
    /** 最后更新时间（ISO） */
    updatedAt: string;
    /** 上一次请求（首步）的开始时刻（ms）；null = 本渠道还没有可算 gap 的请求 */
    lastRequestAt: number | null;
    /** 今日已提示次数（按渠道记；跨 turn、跨进程重启累计，日期一变归零） */
    hints: { date: string; count: number };
}

/** 一条「缓存可能已冷」提示（顶栏 bar 的数据） */
export const CacheHintSchema = z.object({
    id: z.string(),
    ts: z.string().describe("产生时刻（ISO）"),
    /** provider/model —— 提示的维度就是这个，别退化成 model */
    channel: z.string().describe("渠道：`<provider>/<model>`"),
    provider: z.string(),
    model: z.string(),
    /** 距上次请求的间隔（ms） */
    gapMs: z.number(),
    /** 当时的两个边界（ms）与**实际触发提示**的那个（max 的结果） */
    safePointMs: z.number(),
    failPointMs: z.number().nullable(),
    thresholdMs: z.number(),
    /** 触发提示的边界是哪一种：fail = 记录过的失效点；safe = 成功案例撑出来的安全期 */
    thresholdKind: z.enum(["safe", "fail"]),
    /** 今日第几次（含本次） */
    todayCount: z.number(),
    taskUri: z.string(),
    persona: z.string().optional(),
});
export type CacheHint = z.infer<typeof CacheHintSchema>;

/** bar 的事件：show = 出现/更新那一行（**只有一行**）；clear = 撤掉 */
export const CacheHintEventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("show"), data: CacheHintSchema }),
    z.object({ kind: z.literal("clear"), data: z.object({ id: z.string() }) }),
]);
export type CacheHintEvent = z.infer<typeof CacheHintEventSchema>;

/** 「缓存时效柱」的数据视图（用量面板用；一个渠道一份） */
export const CacheChannelViewSchema = z.object({
    channel: z.string().describe("渠道：`<provider>/<model>`"),
    provider: z.string(),
    model: z.string(),
    safePointMs: z.number(),
    /** null = +∞（从没失败过 → 柱右半段不标红） */
    failPointMs: z.number().nullable(),
    /** 上一次首步请求的开始时刻（ms）；null = 算不出"现在" */
    lastRequestAt: z.number().nullable(),
    /** 参与 safePoint 的样本数（0 = 还没历史，safePoint 是 60s 的保护值） */
    samples: z.number(),
    hintsToday: z.number(),
});
export type CacheChannelView = z.infer<typeof CacheChannelViewSchema>;

/** 渠道键：`<provider>/<model>`（provider 段是 models.dev id 或 `custom:<key>`） */
export function channelKey(provider: string, model: string): string {
    return `${provider}/${model}`;
}

/** 渠道键反解（store 里只有字符串；UI/CLI 要分别拿到两段） */
export function splitChannel(key: string): { provider: string; model: string } {
    const i = key.indexOf("/");
    return i <= 0 ? { provider: "", model: key } : { provider: key.slice(0, i), model: key.slice(i + 1) };
}

/** 新的渠道统计（无历史：safePoint=60s、failPoint=+∞） */
export function emptyChannelStats(nowIso: string): ChannelStats {
    return {
        safePoint: SAFE_POINT_DEFAULT_MS,
        failPoint: null,
        samples: [],
        updatedAt: nowIso,
        lastRequestAt: null,
        hints: { date: "", count: 0 },
    };
}

/** 升序数组的 P90（最近秩法）；空数组返回 null */
export function percentile90(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    // 最近秩：ceil(0.9 * n) 项（1-based）；n=1 → 唯一那个值，n=100 → 第 90 项
    const idx = Math.max(0, Math.ceil(0.9 * sorted.length) - 1);
    return sorted[idx] ?? null;
}

/** safePoint = samples 的 P90；无 sample → 60s */
export function safePointOf(samples: readonly number[]): number {
    const p = percentile90(samples.filter((g) => g > 0));
    return p ?? SAFE_POINT_DEFAULT_MS;
}

/** 记一次首步成功：把 gap 追加进窗口（超窗口丢最老的） */
export function withSuccessGap(samples: readonly number[], gapMs: number): number[] {
    if (!(gapMs > 0)) return [...samples];
    const next = [...samples, gapMs];
    return next.length > SAFE_POINT_WINDOW ? next.slice(next.length - SAFE_POINT_WINDOW) : next;
}

/** 记一次首步全未命中：failPoint 取**更小**的那个（只降不升） */
export function tightenFailPoint(current: number | null, gapMs: number): number | null {
    if (!(gapMs > 0)) return current;
    return current === null ? gapMs : Math.min(current, gapMs);
}

/**
 * 一次首步失败的**边界更新**（含"安全区内失败一律忽略"这条闸门）。
 *
 * 为什么不直接调 tightenFailPoint：安全区内（gap ≤ safePoint）的未命中几乎都是
 * 上游抖动 / 前缀变了（不是过期），拿它去收紧边界会让 failPoint 一路掉到分钟级，
 * 于是每次隔一两分钟回来都提示一次 —— 用户原话「不然提示就过多了」。
 *
 * 返回原值 = 这次失败被忽略（调用方据此决定要不要出声）。
 */
export function recordFailureGap(
    safePointMs: number,
    failPointMs: number | null,
    gapMs: number,
): number | null {
    if (!(gapMs > 0)) return failPointMs;
    if (gapMs <= safePointMs) return failPointMs;
    return tightenFailPoint(failPointMs, gapMs);
}

/** 首步的缓存命中率；输入为 0 时 null（量不到不是 0） */
export function firstStepHitRate(inputTokens: number, cacheRead: number): number | null {
    return inputTokens > 0 ? cacheRead / inputTokens : null;
}

/** 首步结果分类：success（真命中）/ miss（≈0）/ null（灰区，不参与统计） */
export function classifyFirstStep(hitRate: number | null): "success" | "miss" | null {
    if (hitRate === null) return null;
    if (hitRate > CACHE_HIT_SUCCESS) return "success";
    if (hitRate < CACHE_HIT_MISS) return "miss";
    return null;
}

/** 边界判定结果 */
export interface HintDecision {
    /** 实际触发提示的边界（max(safePoint, failPoint)） */
    thresholdMs: number;
    /** 是哪种边界触发的 */
    thresholdKind: "safe" | "fail";
}

/**
 * 是否该提示。返回 null = 不提示（含三种原因：算不出 gap / 间隔太短 / 没越过边界）。
 *
 * 判据逐字按 ##477 定稿：
 *   `gap > 60s && gap > max(safePoint, failPoint)`
 * failPoint=null（+∞）时 max 也是 +∞ ⇒ 永不提示（无失败证据不猜）。
 */
export function decideHint(input: {
    gapMs: number | null;
    safePointMs: number;
    failPointMs: number | null;
}): HintDecision | null {
    const { gapMs, safePointMs, failPointMs } = input;
    if (gapMs === null || !(gapMs > 0)) return null;
    if (gapMs <= HINT_MIN_GAP_MS) return null;
    const fail = failPointMs ?? Number.POSITIVE_INFINITY;
    const thresholdMs = Math.max(safePointMs, fail);
    if (!(gapMs > thresholdMs)) return null;
    return {
        thresholdMs,
        // 相等时按 fail 说（那是记录过的失效事实，比"安全期"更有说服力）
        thresholdKind: fail >= safePointMs ? "fail" : "safe",
    };
}

/** 间隔的人类可读形式：`35s` / `42min` / `1h05min` */
export function formatGap(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "?";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const totalMin = Math.round(ms / 60_000);
    if (totalMin < 60) return `${totalMin}min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}min`;
}

/** bar 上的**唯一一行**文案（短、一眼懂、带数字与下一步） */
export function cacheHintText(h: CacheHint): string {
    const why =
        h.thresholdKind === "fail"
            ? `超过记录的 ${formatGap(h.thresholdMs)} 失效点`
            : `超过 ${formatGap(h.thresholdMs)} 安全期`;
    return (
        `⚠ 缓存可能已冷 · 距上次 ${formatGap(h.gapMs)}（${why}）` +
        ` · 今日第 ${h.todayCount} 次 · 建议换个模型或先压缩`
    );
}

/** 今日计数：日期一变归零（日期用本地日期，与用户"今日"一致） */
export function bumpTodayCount(
    prev: { date: string; count: number },
    today: string,
): { date: string; count: number } {
    return prev.date === today ? { date: today, count: prev.count + 1 } : { date: today, count: 1 };
}

/** 本地日期键（`YYYY-MM-DD`） */
export function localDateKey(now: Date): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// ─── 缓存时效柱（用量面板；对数刻度，##477 追加） ─────────────

/** 柱的时间轴范围：1min → 24h（跨度太大，线性刻度会把 5min 与 10min 挤成一点） */
export const CACHE_AGE_DOMAIN_MIN_MS = 60_000;
export const CACHE_AGE_DOMAIN_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * 时间 → 柱上的横向位置（0~1），**对数刻度**。
 * 域外夹到两端（点不该画到柱外面）。
 */
export function logScalePos(ms: number, minMs = CACHE_AGE_DOMAIN_MIN_MS, maxMs = CACHE_AGE_DOMAIN_MAX_MS): number {
    if (!(ms > 0) || !(maxMs > minMs)) return 0;
    const v = Math.log(ms / minMs) / Math.log(maxMs / minMs);
    return Math.min(1, Math.max(0, v));
}

/**
 * 当前间隔落在哪一段：安全区（safePoint 左）/ 警告区（两标记之间）/ 危险区（失效点右）。
 *
 * failPoint 低于 safePoint 时**不再是有效危险线**（安全点优先 —— 与提示判据同一个口径）：
 * 那时右半段只算警告区，不标红。failPoint=+∞ 同理（没失败证据不吓人）。
 */
export function cacheAgeZone(
    gapMs: number,
    safePointMs: number,
    failPointMs: number | null,
): "safe" | "warn" | "danger" {
    if (gapMs <= safePointMs) return "safe";
    if (failPointMs === null || failPointMs <= safePointMs) return "warn";
    return gapMs > failPointMs ? "danger" : "warn";
}

/** 柱上**生效**的失效线：安全点更高时按安全点画（两条线重合时以更严的那条为准） */
export function effectiveFailLine(safePointMs: number, failPointMs: number | null): number | null {
    return failPointMs === null ? null : Math.max(failPointMs, safePointMs);
}

/** 柱上要标的刻度（1min / 5min / 1h / 24h，都在域内且不重叠时才有意义） */
export const CACHE_AGE_TICKS_MS: readonly number[] = [60_000, 5 * 60_000, 60 * 60_000, 24 * 60 * 60 * 1000];
