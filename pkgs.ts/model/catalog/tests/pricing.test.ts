// tests/pricing.test.ts —— DeepSeek 峰谷计价（模型策略）
//
// 锁的是**官方口径**（2026-11-28 对照价页确认）：
//   峰段 = 01:00–04:00 与 06:00–10:00 UTC，周一至周五，排除中国法定假日；
//   峰价 = 谷价 × 2；models.dev 收录的是谷价。
//
// 为什么值得一条测试：算钱错了不会抛异常，只会静默少算 / 多算。

import { describe, expect, it } from 'vitest';

import { costOf, priceMultiplierOf } from '../src/index.js';

const DS = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' };

describe('priceMultiplierOf（DeepSeek 峰谷）', () => {
    it('工作日峰段 ×2（两段都覆盖）', () => {
        // 2026-11-24 是周二
        expect(priceMultiplierOf(DS, new Date('2026-11-24T02:00:00Z'))).toEqual({ factor: 2, label: 'peak' });
        expect(priceMultiplierOf(DS, new Date('2026-11-24T08:00:00Z'))).toEqual({ factor: 2, label: 'peak' });
    });

    it('峰段边界是左闭右开（04:00 / 10:00 已回谷价）', () => {
        expect(priceMultiplierOf(DS, new Date('2026-11-24T00:59:00Z')).factor).toBe(1);
        expect(priceMultiplierOf(DS, new Date('2026-11-24T04:00:00Z')).factor).toBe(1);
        expect(priceMultiplierOf(DS, new Date('2026-11-24T06:00:00Z')).factor).toBe(2);
        expect(priceMultiplierOf(DS, new Date('2026-11-24T10:00:00Z')).factor).toBe(1);
    });

    it('周末整日谷价', () => {
        // 2026-11-28 是周六
        expect(priceMultiplierOf(DS, new Date('2026-11-28T02:00:00Z'))).toEqual({ factor: 1, label: 'off-peak' });
    });

    it('中国法定假日整日谷价（2026-10-01 周四 02:00 UTC）', () => {
        expect(priceMultiplierOf(DS, new Date('2026-10-01T02:00:00Z')).factor).toBe(1);
    });

    it('非 DeepSeek 模型不套峰谷（原价）', () => {
        expect(
            priceMultiplierOf({ providerId: 'goat', modelId: 'gpt-6-sol' }, new Date('2026-11-24T02:00:00Z')),
        ).toEqual({ factor: 1 });
    });

    it('网关售卖的 deepseek 模型同样按模型族套（provider 不影响判据）', () => {
        expect(
            priceMultiplierOf(
                { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' },
                new Date('2026-11-24T02:00:00Z'),
            ).factor,
        ).toBe(2);
    });
});

describe('costOf × 峰谷策略', () => {
    const cost = { input: 1, output: 2 };

    it('不给 pricing（老调用方）⇒ 原价', () => {
        expect(costOf(cost, { inputTokens: 100, outputTokens: 10 })).toBeCloseTo(0.00012, 12);
    });

    it('谷价时段 = 原价；峰段 = 翻倍', () => {
        const usage = { inputTokens: 100, outputTokens: 10 };
        expect(costOf(cost, usage, { ...DS, at: new Date('2026-11-24T12:00:00Z') })).toBeCloseTo(0.00012, 12);
        expect(costOf(cost, usage, { ...DS, at: new Date('2026-11-24T02:00:00Z') })).toBeCloseTo(0.00024, 12);
    });

    it('缓存读也一起翻倍（同一倍率覆盖所有桶）', () => {
        const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 };
        const off = costOf(cost, usage, { ...DS, at: new Date('2026-11-24T12:00:00Z') })!;
        const peak = costOf(cost, usage, { ...DS, at: new Date('2026-11-24T02:00:00Z') })!;
        expect(peak).toBeCloseTo(off * 2, 12);
    });
});
