// strategies/index.ts —— 模型策略注册表（纯函数，零 IO）
//
// 目录约定：
//   · models/<family>/… —— 一个模型族一个目录（deepseek 的峰谷计价在 models/deepseek/pricing.ts）
//
// 加新模型族 = 新增一个目录 + 在 MODEL_PRICING_STRATEGIES 里加一行（顺序即优先级）。
// 没认领的模型 = 原价（factor 1），不猜。

import { deepseekPricing } from './models/deepseek/pricing.js';
import type { ModelPricingStrategy, PricingMultiplier } from './types.js';

export type { ModelPricingStrategy, PricingMultiplier } from './types.js';
export { deepseekPricing } from './models/deepseek/pricing.js';

/** 注册表：按顺序匹配，第一个命中的生效 */
export const MODEL_PRICING_STRATEGIES: readonly ModelPricingStrategy[] = [deepseekPricing];

/**
 * 这个模型在该时刻的计费倍率。
 *
 * 没有策略认领 ⇒ `{ factor: 1 }`（models.dev 原价）。**不要**默认成任何折扣：
 * 认不出来就按原价，宁可多算也不要少算（少算是静默错账）。
 */
export function priceMultiplierOf(
    model: { readonly providerId?: string; readonly modelId: string },
    at: Date = new Date(),
    registry: readonly ModelPricingStrategy[] = MODEL_PRICING_STRATEGIES,
): PricingMultiplier {
    for (const strategy of registry) {
        if (strategy.matches(model)) return strategy.multiplierAt(at);
    }
    return { factor: 1 };
}
