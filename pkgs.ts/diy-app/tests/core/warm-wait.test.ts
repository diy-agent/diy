// tests/core/warm-wait.test.ts
// 🎯 ##486 冷缓存等待：判据 + 装配层。无网络、无 Electron、**不真睡**（sleep 注入）。
//
// 用户的核心顾虑是「别写成每步都 sleep」，所以本文件有一条**对比测试**（判据 2）：
// 把一组典型的「上一步正常」的步喂进去，断言 sleep 一次都没被调用（零延迟）；
// 再把全冷的那一条喂进去，断言恰好睡 1000ms 一次。两侧同一把尺子，不能各写一套。

import { describe, expect, it, vi } from "vitest";
import {
    COLD_CACHE_RATIO_MAX,
    COLD_MIN_INPUT_TOKENS,
    WARM_WAIT_MS,
    decideWarmWait,
    isColdStep,
} from "../../src/shared/warm-wait";
import { abortableSleep, warmWaitEnabled, warmWaitIfCold } from "../../src/main/services/warm-wait";
import type { StepUsageRecord } from "../../src/shared/usage";

/** 拼一个「输入 inputTotal、缓存读 cacheRead」的上一步 */
const step = (inputTotal: number, cacheRead: number): { cacheRead: number; inputTotal: number } => ({
    cacheRead,
    inputTotal,
});

/** 大请求（> 阈值）全冷：本刀的唯一触发条件 */
const COLD_BIG = step(100_000, 0);

describe("判据：只在「上一步全冷」时等", () => {
    it("上一步全冷（大请求、缓存读 0）⇒ 等 1000ms", () => {
        const d = decideWarmWait({ enabled: true, last: COLD_BIG });
        expect(d).toMatchObject({ waitMs: WARM_WAIT_MS, skip: null, lastCacheRatio: 0 });
    });

    it("上一步正常（命中率高）⇒ 零等待", () => {
        const d = decideWarmWait({ enabled: true, last: step(100_000, 90_000) });
        expect(d).toMatchObject({ waitMs: 0, skip: "warm", lastCacheRatio: 0.9 });
    });

    it(`命中率恰好 ${COLD_CACHE_RATIO_MAX} 不算全冷（严格小于才等）`, () => {
        const at = decideWarmWait({ enabled: true, last: step(100_000, COLD_CACHE_RATIO_MAX * 100_000) });
        expect(at.skip).toBe("warm");
        const below = decideWarmWait({ enabled: true, last: step(100_000, COLD_CACHE_RATIO_MAX * 100_000 - 1) });
        expect(below.skip).toBeNull();
    });

    it(`输入恰好 ${COLD_MIN_INPUT_TOKENS} 的小请求不等（> 才启用）`, () => {
        const d = decideWarmWait({ enabled: true, last: step(COLD_MIN_INPUT_TOKENS, 0) });
        expect(d).toMatchObject({ waitMs: 0, skip: "small-request" });
        const over = decideWarmWait({ enabled: true, last: step(COLD_MIN_INPUT_TOKENS + 1, 0) });
        expect(over.skip).toBeNull();
    });

    it("没有上一步（进程刚起 / 新任务首轮）⇒ 不等", () => {
        expect(decideWarmWait({ enabled: true, last: null })).toMatchObject({ waitMs: 0, skip: "no-previous" });
        // 输入为 0 的账（空回复步）也算「没有可比的数」，不是全冷
        expect(decideWarmWait({ enabled: true, last: step(0, 0) })).toMatchObject({
            waitMs: 0,
            skip: "no-previous",
        });
    });

    it("开关关掉 ⇒ 连判据都不算，一律不等（DIY_NO_WARM_WAIT=1）", () => {
        expect(decideWarmWait({ enabled: false, last: COLD_BIG })).toMatchObject({ waitMs: 0, skip: "disabled" });
    });

    it("isColdStep 只回答口径，不含开关与小请求闸门", () => {
        expect(isColdStep(step(100_000, 0))).toBe(true);
        expect(isColdStep(step(100, 0))).toBe(true); // 小请求也是「全冷」，只是不启用等待
        expect(isColdStep(step(100_000, 5_000))).toBe(false);
        expect(isColdStep(null)).toBe(false);
    });
});

describe("装配层：对比测试（判据 2 —— 正常路径零延迟）", () => {
    /** 一条真实的暖链：每一步都命中大半缓存（跨轮首步 0.86、轮内步 0.97） */
    const WARM_CHAIN = [step(120_000, 103_000), step(140_000, 136_000), step(180_000, 175_000)];

    it("上一步正常的步：一次 sleep 都不排（普遍延迟 = 0）", async () => {
        const sleep = vi.fn(async () => {});
        for (const last of WARM_CHAIN) {
            const out = await warmWaitIfCold(last, { enabled: true, sleep });
            expect(out.waitedMs).toBe(0);
        }
        expect(sleep).not.toHaveBeenCalled();
    });

    it("上一步全冷：恰好睡一次 1000ms，并回报 waitedMs（记账来源）", async () => {
        const sleep = vi.fn(async () => {});
        const out = await warmWaitIfCold(COLD_BIG, { enabled: true, sleep });
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(WARM_WAIT_MS, undefined);
        expect(out).toMatchObject({ waitedMs: WARM_WAIT_MS, skip: null });
    });

    it("小请求全冷：不睡（测试与短对话不被拖慢）", async () => {
        const sleep = vi.fn(async () => {});
        await warmWaitIfCold(step(30_000, 0), { enabled: true, sleep });
        expect(sleep).not.toHaveBeenCalled();
    });

    it("DIY_NO_WARM_WAIT=1 ⇒ 环境开关关掉，全冷也不睡", async () => {
        expect(warmWaitEnabled({ DIY_NO_WARM_WAIT: "1" } as NodeJS.ProcessEnv)).toBe(false);
        expect(warmWaitEnabled({} as NodeJS.ProcessEnv)).toBe(true);
        const sleep = vi.fn(async () => {});
        const out = await warmWaitIfCold(COLD_BIG, { enabled: warmWaitEnabled({ DIY_NO_WARM_WAIT: "1" } as NodeJS.ProcessEnv), sleep });
        expect(sleep).not.toHaveBeenCalled();
        expect(out.waitedMs).toBe(0);
    });

    it("等待可被中止：这一轮被停掉时不空等完 1 秒", async () => {
        const ac = new AbortController();
        const t0 = Date.now();
        const p = abortableSleep(5_000, ac.signal);
        ac.abort();
        await p;
        expect(Date.now() - t0).toBeLessThan(1_000);
        // 已中止的信号直接返回
        await abortableSleep(5_000, ac.signal);
    });
});

describe("记账字段（判据 4 的数据源）", () => {
    it("waitedMs 只在等待时出现：没等的步 JSON 里没有这个键", () => {
        const base = { ts: "t", turnId: "turn", step: 1, model: "m", apiFace: "chat", usage: {} } as unknown as StepUsageRecord;
        expect("waitedMs" in JSON.parse(JSON.stringify(base))).toBe(false);
        const waited = { ...base, waitedMs: WARM_WAIT_MS } as StepUsageRecord;
        expect(JSON.parse(JSON.stringify(waited)).waitedMs).toBe(WARM_WAIT_MS);
    });
});
