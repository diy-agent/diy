// tests/core/turn-usage.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 usage 账本口径（##140 的验收指标、##148 收益量化的唯一数据源）。
//
// 209 review 的 C-7 结论是"cachedInputTokens 未采集 → 省多少钱无法测"。本文件守的就是
// 这件事别再退化：**命中数必须来自 usage.inputTokenDetails.cacheReadTokens**，
// 而不是 providerMetadata（zen/go 实测那是个空对象 `{"zen-go":{}}`，走它永远拿不到数）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { addStepUsage, newUsageAcc, setTurnUsage, cacheHitRate, type TurnUsage } from "../../src/main/services/turn-usage";

/** 一步的 usage（形状照抄真实上游实测数据：zen/go + mimo-v2.6-flash） */
const step = (input: number, cached: number, out = 10): TurnUsage => ({
    inputTokens: input,
    outputTokens: out,
    totalTokens: input + out,
    inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached, cacheWriteTokens: undefined },
});

describe("usage 账本", () => {
    it("空账本为全 0（cached 是独立字段，不是从 input 推出来的）", () => {
        expect(newUsageAcc()).toEqual({ in: 0, out: 0, cached: 0, total: 0 });
    });

    it("逐步累加：in/out/cached/total 各自求和（多步 = 各步之和，与流尾 totalUsage 同口径）", () => {
        const acc = newUsageAcc();
        addStepUsage(acc, step(7289, 0, 85));
        addStepUsage(acc, step(7300, 7232, 40));
        expect(acc).toEqual({ in: 7289 + 7300, out: 125, cached: 7232, total: 7289 + 7300 + 125 });
    });

    it("流尾权威值覆盖（含 cached）：totalUsage 缺字段时保留累加值", () => {
        const acc = newUsageAcc();
        addStepUsage(acc, step(100, 50, 10));
        setTurnUsage(acc, { inputTokens: 120, outputTokens: 12, totalTokens: 132, inputTokenDetails: { cacheReadTokens: 96 } });
        expect(acc).toEqual({ in: 120, out: 12, cached: 96, total: 132 });
        // 半截 usage（只有 input）：其余字段不动
        setTurnUsage(acc, { inputTokens: 200 });
        expect(acc).toEqual({ in: 200, out: 12, cached: 96, total: 212 });
    });

    it("没有 inputTokenDetails 的 provider 不会写出 NaN/负值（cached 保持 0）", () => {
        const acc = newUsageAcc();
        addStepUsage(acc, { inputTokens: 10, outputTokens: 1, totalTokens: 11 });
        expect(acc.cached).toBe(0);
        expect(cacheHitRate(acc)).toBe(0);
    });

    it("undefined 步骤不改变账本（流里可能没有 usage 的 part）", () => {
        const acc = newUsageAcc();
        addStepUsage(acc, undefined);
        setTurnUsage(acc, undefined);
        expect(acc).toEqual({ in: 0, out: 0, cached: 0, total: 0 });
    });

    it("命中率：输入为 0 时返回 0（不是 NaN），正常时是 cached/in", () => {
        expect(cacheHitRate({ in: 0, cached: 0 })).toBe(0);
        expect(cacheHitRate({ in: 7289, cached: 7232 })).toBeCloseTo(0.9921, 3);
    });

    it("★ 上游真实形状：cacheRead 从 inputTokenDetails 读，providerMetadata 里没有它", () => {
        // 实测数据（2026-10-02，zen/go，mimo-v2.6-flash，同前缀第二次请求）：
        //   usage.inputTokenDetails = { noCacheTokens: 57, cacheReadTokens: 7232 }
        //   providerMetadata = { "zen-go": {} }  ← 空的
        const real: TurnUsage = {
            inputTokens: 7289,
            outputTokens: 4,
            totalTokens: 7293,
            inputTokenDetails: { noCacheTokens: 57, cacheReadTokens: 7232, cacheWriteTokens: undefined },
        };
        const acc = newUsageAcc();
        addStepUsage(acc, real);
        expect(acc.cached).toBe(7232);
        expect(cacheHitRate(acc)).toBeGreaterThan(0.99);
    });
});
