// cost.ts — 价目 × 用量 = 金额（纯函数，无 IO）
//
// 价目表就在本包（`ModelCatalogCost`），算价与价目天然在一起：
// 调用方只拿「上一步的桶」进来，不用自己再抄一遍 /1e6 与缓存价规则。
//
// 口径（与 model.yaml 的 `cost` 同义）：
//   · `input` / `output` = 每 1M tokens 的美元单价
//   · `cacheRead` 缺省 = 按 `input` 计（读缓存不涨价）
//   · 缓存读的 tokens **已经包含在 `inputTokens` 里**（usage 的约定），这里先扣出来再按缓存价算
//   · 没有价目 ⇒ `undefined`（不编 0：UI 显示「—」）

import type { ModelCatalogCost } from "./types.js";

/** 一次调用的用量（只取算价需要的三项；与 session 的 TokenUsage 结构兼容） */
export interface CostUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
}

/** 一次调用的花费（USD）；无价目 ⇒ `undefined` */
export function costOf(cost: ModelCatalogCost | undefined, usage: CostUsage): number | undefined {
    if (cost === undefined) return undefined;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const input = usage.inputTokens - cacheRead;
    const total =
        (input * cost.input + usage.outputTokens * cost.output) / 1_000_000 +
        (cacheRead * (cost.cacheRead ?? cost.input)) / 1_000_000;
    return total;
}
