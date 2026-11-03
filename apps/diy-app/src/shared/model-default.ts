// src/shared/model-default.ts
// 🎯 「缺省模型」口径的**唯一代码真源**（seed 的种子人物、`diy seed --help` 文案共用一个来源）。
//
// 口径（与人读的那条规则同源：仓库根 `AGENTS.md::model.default`）：
//   **允许清单内 free 优先 → 退 `mimo-v2.5`**。
//   · free 模型 = 套餐内 cost 全 0（模型 id 带 `free` 后缀）→ 优先选它，本地 agent 测试不烧钱
//   · free **上架 / 下架频繁**，且未经实测的 free 可能是「上架预告」（上游 400
//     `[model_coming_soon]`）⇒ 只认**人工实测过**的那几个（清单 + 核对日期见下）
//   · 一个都没命中（快照没收录 / 已下架 / 换机）→ 退 `mimo-v2.5`（付费但稳）
//
// ⚠️ **别在别处再抄一份模型名字符串**：抄一份就会与这里分叉（本模块的由来就是
// `core/seed.ts` 写死 `mimo-v2.6-flash` 而上游已下架 —— 种出来的环境开箱即坏）。

/** 兜底缺省模型：free 一个都不可用时用它（付费但稳定；允许清单内） */
export const FALLBACK_MODEL = "mimo-v2.5";

/**
 * free 候选（**按偏好排序**，前面的先用）。
 * 只收**人工实测可用**的（流式 + 工具都通才行）；核对日期见 `FREE_MODEL_CHECKED_AT`，
 * 核对方法与真源（`https://opencode.ai/zen/go/v1/models` 筛 `free` + 各实测一条）见仓库根 `AGENTS.md::model.free`。
 */
export const FREE_MODEL_CANDIDATES: readonly string[] = ["beam-free", "longcat-2.5-preview-free"];

/** `FREE_MODEL_CANDIDATES` 的人工核对日期（过期即重核，别默默沿用） */
export const FREE_MODEL_CHECKED_AT = "2026-10-17";

/**
 * **已下线 / 不可用**的模型：上游返回 `[model_coming_soon]`（实测）。
 * 允许清单里曾经有它们，但**禁止**拿来做缺省 —— 写进配置 = 环境开箱即坏。
 */
export const RETIRED_MODELS: readonly string[] = ["mimo-v2.6-flash"];

/**
 * 从「该 provider 实际可用的模型 id」（models.dev 快照 ⊕ custom spec）里挑缺省模型：
 * free 候选按偏好序取第一个**确实存在**的；一个都没有 → `FALLBACK_MODEL`。
 *
 * 为什么必须拿「实际可用清单」筛一遍：候选不在目录里 = 应用根本列不出它，
 * 种子人物写了它只会显示成「模型不可用」（比写付费兜底更糟）。
 */
export function pickDefaultModel(available: readonly string[]): string {
    const set = new Set(available);
    return FREE_MODEL_CANDIDATES.find((id) => set.has(id)) ?? FALLBACK_MODEL;
}
