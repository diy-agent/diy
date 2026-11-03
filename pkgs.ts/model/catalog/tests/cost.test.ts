// tests/cost.test.ts — 价目 × 用量 = 金额（##505-C：从 apps/chat 的 stepCost 搬来）
import { describe, expect, it } from "vitest";
import { costOf } from "../src/index.js";

describe("costOf（上一步花费）", () => {
    it("input / output 按每 1M 计价", () => {
        // 100 输入（其中 0 缓存）+ 10 输出
        expect(costOf({ input: 1, output: 2 }, { inputTokens: 100, outputTokens: 10 })).toBeCloseTo(0.00012, 12);
    });

    it("缓存读 tokens 已含在 inputTokens 里：先扣出来，再按 cacheRead 价算（缺省 = input 价）", () => {
        // 100 输入里 40 是缓存读：60*1 + 40*(cacheRead ?? input) + 10*2
        expect(costOf({ input: 1, output: 2 }, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 })).toBeCloseTo(
            0.00012,
            12,
        );
        // 缓存读更便宜时按缓存价：60*1 + 40*0.5 + 10*2
        expect(
            costOf(
                { input: 1, output: 2, cacheRead: 0.5 },
                { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 },
            ),
        ).toBeCloseTo(0.0001, 12);
    });

    it("没有价目 ⇒ undefined（不编 0）", () => {
        expect(costOf(undefined, { inputTokens: 100, outputTokens: 10 })).toBeUndefined();
    });
});
