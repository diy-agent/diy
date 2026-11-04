// output-limit.probe.test.ts — 输出上限的三态（未知 / 非法 / 正常）必须分开
//
// 探针来源（真实故障，不是编的）：
//   `streamText({ maxOutputTokens: 0 })` 会被 ai-sdk 直接拒 —— "maxOutputTokens must be >= 1"
//   （##184 实测）。而「模型没声明上限」是常态：models.dev 有时只给 context_length，
//   providers.custom.yaml 也可能漏写 limit.output。
//
// 三种语义必须分开，混了就是静默故障：
//   undefined  = 模型没声明极限
//   0 / 负数   = 上游给了非法值（当"没声明"处理）
//   >= 1       = 正常
//
// 真实代价（local-agent.ts 头注）：曾经直接把 models.dev 的 limit.output 当"我们愿意付的
// 上限"，生产最贵一条 output=131072=2^17 正好撞死。

import { describe, expect, it } from 'vitest';
import { effectiveMaxOutputTokens } from '../src/index.js';

const entry = (maxOutputTokens?: number) => ({ maxOutputTokens });

describe('effectiveMaxOutputTokens（保证 >= 1）', () => {
    it('模型声明了正值 ⇒ 用它', () => {
        expect(effectiveMaxOutputTokens(entry(8192), 16384)).toBe(8192);
    });

    it('模型没声明 ⇒ 回退 fallback（**绝不发 0**）', () => {
        expect(effectiveMaxOutputTokens(entry(undefined), 16384)).toBe(16384);
        expect(effectiveMaxOutputTokens(undefined, 2048)).toBe(2048);
    });

    it('上游给了 0 / 负数 ⇒ 当"没声明"，回退 fallback', () => {
        expect(effectiveMaxOutputTokens(entry(0), 16384)).toBe(16384);
        expect(effectiveMaxOutputTokens(entry(-1), 16384)).toBe(16384);
    });

    it('NaN / Infinity ⇒ 回退（非法数不能漏到 wire 上）', () => {
        expect(effectiveMaxOutputTokens(entry(Number.NaN), 1000)).toBe(1000);
        expect(effectiveMaxOutputTokens(entry(Number.POSITIVE_INFINITY), 1000)).toBe(1000);
    });

    it('fallback 自己也不合法时，结果**仍然 >= 1**（最后一道闸）', () => {
        expect(effectiveMaxOutputTokens(entry(undefined), 0)).toBe(1);
        expect(effectiveMaxOutputTokens(entry(undefined), -5)).toBe(1);
    });

    it('小数会被取整（token 数不能是小数）', () => {
        expect(effectiveMaxOutputTokens(entry(8192.7), 1000)).toBe(8192);
        expect(effectiveMaxOutputTokens(entry(undefined), 16384.9)).toBe(16384);
    });

    it('1 是合法值（下界包含）', () => {
        expect(effectiveMaxOutputTokens(entry(1), 16384)).toBe(1);
    });
});
