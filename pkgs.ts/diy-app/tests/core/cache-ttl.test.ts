// tests/core/cache-ttl.test.ts
// 🎯 缓存 TTL 的实测夹逼（##269）—— 纯函数，无网络无 Electron
//
// 三条契约：
//   ① 间隔删失：命中给下界、未命中给上界 → ttl ∈ (aliveUpTo, deadFrom]
//   ② 前缀变了的观测**不进夹逼**（那是 invalidated 不是 expired）
//   ③ 自相矛盾（更短间隔失效却有更长间隔命中）→ 整段退回先验，不硬编一个数

import { describe, it, expect } from "vitest";
import {
    cacheStateAfterGap,
    effectiveTtl,
    ttlBoundsFrom,
    type CacheObservation,
} from "../../src/shared/context/cache-ttl";
import { CACHE_TTL_PRIOR_MS, cacheTtlMsOf } from "../../src/shared/models";

const MIN = 60_000;
const obs = (gapMin: number, hit: boolean, samePrefix = true): CacheObservation => ({
    gapMs: gapMin * MIN,
    hit,
    samePrefix,
});

describe("ttlBoundsFrom：区间删失夹逼", () => {
    it("30 分钟还命中、45 分钟失效 → ttl ∈ (30min, 45min]", () => {
        const b = ttlBoundsFrom([obs(30, true), obs(45, false)]);
        expect(b.aliveUpTo).toBe(30 * MIN);
        expect(b.deadFrom).toBe(45 * MIN);
        expect(b.samples).toBe(2);
        expect(b.conflicted).toBe(false);
    });

    it("只命中过 → 只有下界（上界未知）", () => {
        const b = ttlBoundsFrom([obs(10, true), obs(20, true)]);
        expect(b.aliveUpTo).toBe(20 * MIN);
        expect(b.deadFrom).toBe(-1);
        expect(b.conflicted).toBe(false);
    });

    it("上界取下确界、下界取上确界（多次观测夹紧）", () => {
        const b = ttlBoundsFrom([obs(5, true), obs(50, true), obs(60, false), obs(90, false)]);
        expect(b.aliveUpTo).toBe(50 * MIN);
        expect(b.deadFrom).toBe(60 * MIN);
    });

    it("前缀变了的观测被排除并计入 suspect（那是作废，不是过期）", () => {
        const b = ttlBoundsFrom([obs(30, true), obs(45, false, false), obs(20, false, false)]);
        expect(b.deadFrom).toBe(-1);
        expect(b.suspect).toBe(2);
        expect(b.samples).toBe(1);
    });

    it("gap<=0 忽略（同一次请求 / 时间戳倒挂）", () => {
        const b = ttlBoundsFrom([obs(0, false), obs(-5, true), obs(30, true)]);
        expect(b.samples).toBe(1);
        expect(b.deadFrom).toBe(-1);
    });

    it("自相矛盾 → conflicted（缓存不可能既活过 45 分钟、又 30 分钟就死）", () => {
        const b = ttlBoundsFrom([obs(45, true), obs(30, false)]);
        expect(b.conflicted).toBe(true);
    });
});

describe("effectiveTtl + cacheStateAfterGap：三态判定", () => {
    it("实测收紧了先验：1h 先验被 45min 上界证伪", () => {
        const t = effectiveTtl(ttlBoundsFrom([obs(30, true), obs(45, false)]), CACHE_TTL_PRIOR_MS);
        expect(t.knownAlive).toBe(30 * MIN);
        expect(t.maybeDead).toBe(45 * MIN);
        expect(t.bounded).toBe(true);
        expect(t.priorFalsified).toBe(true); // 45min < 1h
    });

    it("三态：≤下界 = alive；> 上界 = dead；灰区 = unknown", () => {
        const t = effectiveTtl(ttlBoundsFrom([obs(30, true), obs(45, false)]), CACHE_TTL_PRIOR_MS);
        expect(cacheStateAfterGap(10 * MIN, t)).toBe("alive");
        expect(cacheStateAfterGap(30 * MIN, t)).toBe("alive");
        expect(cacheStateAfterGap(40 * MIN, t)).toBe("unknown");
        expect(cacheStateAfterGap(46 * MIN, t)).toBe("dead");
        expect(cacheStateAfterGap(10 * 60 * MIN, t)).toBe("dead"); // 隔一晚上
    });

    it("矛盾数据 → 退回先验（宁可用一个可能错的常数，也不用矛盾数据）", () => {
        const t = effectiveTtl(ttlBoundsFrom([obs(45, true), obs(30, false)]), CACHE_TTL_PRIOR_MS);
        expect(t.bounded).toBe(false);
        expect(cacheStateAfterGap(30 * MIN, t)).toBe("unknown");
        expect(cacheStateAfterGap(90 * MIN, t)).toBe("dead"); // 超过先验
    });

    it("无实测 → 先验单独判：超先验 = dead，之内 = unknown（不敢说 alive）", () => {
        const t = effectiveTtl(ttlBoundsFrom([]), CACHE_TTL_PRIOR_MS);
        expect(cacheStateAfterGap(30 * MIN, t)).toBe("unknown");
        expect(cacheStateAfterGap(2 * 60 * MIN, t)).toBe("dead");
    });

    it("先验被证伪且无实测上界时更保守：不轻易说 dead（宁可探测）", () => {
        // 上界缺失但下界 > 先验 → 说明先验明显偏小
        const t = effectiveTtl(ttlBoundsFrom([obs(120, true)]), CACHE_TTL_PRIOR_MS);
        expect(t.priorFalsified).toBe(false); // 无上界 → 不算证伪
        expect(cacheStateAfterGap(90 * MIN, t)).toBe("alive");
    });
});

describe("模型侧先验", () => {
    it("四个模型都带 cacheTtlMs，缺省 1 小时；未知模型回落先验", () => {
        expect(cacheTtlMsOf("mimo-v2.6-flash")).toBe(CACHE_TTL_PRIOR_MS);
        expect(cacheTtlMsOf("deepseek-v4.1-flash")).toBe(CACHE_TTL_PRIOR_MS);
        expect(cacheTtlMsOf("不存在的模型")).toBe(CACHE_TTL_PRIOR_MS);
        expect(CACHE_TTL_PRIOR_MS).toBe(60 * 60 * 1000);
    });
});
