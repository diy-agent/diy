// src/shared/context/cache-ttl.ts
// 🎯 缓存 TTL 的**实测夹逼**（纯函数，禁止 import node:*）
//
// ── 为什么需要它（用户 2026-10-06）──
// 官方**一律不提供**缓存存活时长。「隔一晚上回来、整段上下文要按全价重付」这件事，
// 是自动压缩最重要的触发时机（那一刻压缩**零重建代价**，见 ##230 的盈亏平衡：
// `N = (T−X)/X × (k−1)`，X=T 时 N=0）—— 所以要能把 TTL **碰出来**。
//
// ── 原理：区间删失（interval censoring）──
// 我们只能观测到「某次请求命中 / 未命中」，观测不到 TTL 本身。但相邻两次请求给出夹逼：
//   · 间隔 `gap` 时**命中** → 缓存至少活过 `gap`     ⇒ `ttl > gap`
//   · 间隔 `gap` 时**未命中** → 缓存最多活到 `gap`   ⇒ `ttl ≤ gap`
// 于是：
//   aliveUpTo = max{ gap | 命中 }      ← 下界
//   deadFrom  = min{ gap | 未命中 }     ← 上界
//   ttl ∈ (aliveUpTo, deadFrom]
// 例：30 分钟还命中、45 分钟失效 → `ttl ∈ (30min, 45min]`（官网声称 1h 被实测**向上证伪**）。
//
// ── 为什么必须带 samePrefix（否则夹逼被污染）──
// 未命中 ≠ 过期。「前缀变了」（system 上下文/模型/面）会让缓存**作废（invalidated）**，
// 跟时间无关；路由/机房漂移（##230 实测 28/5032 次「3 秒就失效」）同理。
// 只用「前缀逐字未变」的观测做夹逼；其余行**单列成可疑**，不参与计算。

/** 一次缓存观测：相邻两次请求的间隔 + 本次是否命中 + 前缀是否逐字未变 */
export interface CacheObservation {
    /** 相邻两次请求的间隔（ms） */
    gapMs: number;
    /** 本次请求的缓存读是否 > 0 */
    hit: boolean;
    /**
     * 前缀是否逐字未变（system 上下文 + 模型 + API 面都没变）。
     * false 的观测**不进夹逼** —— 那种未命中是「作废」不是「过期」。
     */
    samePrefix: boolean;
}

export interface TtlBounds {
    /** 下界：观测到「还活着」的最大间隔（-1 = 没有可用观测） */
    aliveUpTo: number;
    /** 上界：观测到「已失效」的最小间隔（-1 = 未知，此时只能给下界） */
    deadFrom: number;
    /** 参与夹逼的观测数 */
    samples: number;
    /** 被判为可疑而排除的观测数（前缀变了 / 不行：见下文的嫌疑判据） */
    suspect: number;
    /** 上下界自相矛盾（有更短的间隔失效、却有更长的间隔命中）→ 多半是路由漂移 */
    conflicted: boolean;
}

/**
 * 从观测集夹出 TTL 区间。
 *
 * 只统计 `samePrefix` 的行；`gapMs <= 0` 忽略（同一次请求/时间戳倒挂）。
 * `conflicted` 的判据：`deadFrom <= aliveUpTo`（物理上不可能 —— 缓存不可能既"活过 45 分钟"
 * 又"30 分钟就死"）→ 说明存在非时间因素，此时**上下界都不可信**，调用方应回头用先验。
 */
export function ttlBoundsFrom(observations: readonly CacheObservation[]): TtlBounds {
    let aliveUpTo = -1;
    let deadFrom = -1;
    let samples = 0;
    let suspect = 0;
    for (const o of observations) {
        if (!o.samePrefix) {
            suspect++;
            continue;
        }
        if (!(o.gapMs > 0)) continue;
        samples++;
        if (o.hit) aliveUpTo = Math.max(aliveUpTo, o.gapMs);
        else deadFrom = deadFrom < 0 ? o.gapMs : Math.min(deadFrom, o.gapMs);
    }
    const conflicted = aliveUpTo >= 0 && deadFrom >= 0 && deadFrom <= aliveUpTo;
    return { aliveUpTo, deadFrom, samples, suspect, conflicted };
}

/**
 * 由「实测区间 + 先验」推出**生效 TTL**（自动压缩的判据）。
 *
 * 语义（别把三种状态揉成一个数，否则判"是否过期"就说不清）：
 *   · `knownAlive(ms)`  —— 距上次请求**不超过**它，缓存**一定还活着**（实测下界）
 *   · `maybeDead(ms)`   —— 超过它，缓存**一定已过期**（实测上界）
 *   · `prior`           —— 两者之间是灰区，只能拿先验做判据
 * 实测自相矛盾（conflicted）→ 整段退回先验（宁可用一个可能错的常数，也不用矛盾的数据）。
 */
export interface EffectiveTtl {
    /** 一定活着的时长 */
    knownAlive: number;
    /** 一定已过期的时长（-1 = 未知，只能用先验） */
    maybeDead: number;
    /** 灰区判据（先验或声明的 cacheTtlMs） */
    prior: number;
    /** 上界是否来自实测（false = 只有下界可用） */
    bounded: boolean;
    /** 实测与先验矛盾（实测上界 < 先验）→ 以实测为准，prior 仅供灰区 */
    priorFalsified: boolean;
}

export function effectiveTtl(bounds: TtlBounds, prior: number): EffectiveTtl {
    if (bounds.conflicted || bounds.aliveUpTo < 0) {
        return { knownAlive: -1, maybeDead: -1, prior, bounded: false, priorFalsified: false };
    }
    const maybeDead = bounds.deadFrom;
    return {
        knownAlive: bounds.aliveUpTo,
        maybeDead,
        prior,
        bounded: maybeDead > 0,
        priorFalsified: maybeDead > 0 && maybeDead < prior,
    };
}

/**
 * 判「距上次请求这么久，缓存是否**确定已过期**（expired）」。
 *
 * 三态（不要返回 boolean —— 「不知道」与「确定过期」的重启策略完全不同：
 * 前者该探测，后者该直接压）：
 *   · "dead"  —— 确定过期（超过实测上界，或超过先验且无实测上界）
 *   · "alive" —— 确定还活着（未超过实测下界）
 *   · "unknown" —— 灰区（只能探测或保守处理）
 */
export function cacheStateAfterGap(gapMs: number, ttl: EffectiveTtl): "dead" | "alive" | "unknown" {
    if (gapMs < 0) return "unknown";
    if (ttl.knownAlive > 0 && gapMs <= ttl.knownAlive) return "alive";
    if (ttl.maybeDead > 0) return gapMs > ttl.maybeDead ? "dead" : "unknown";
    // 没有实测上界：先验就是唯一判据（先验被实测证伪时更保守：不敢说 dead）
    if (ttl.priorFalsified) return "unknown";
    return gapMs > ttl.prior ? "dead" : "unknown";
}
