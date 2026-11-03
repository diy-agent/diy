// catalog.ts — 最小模型目录（静态数据 + 纯函数查询）。
//
// 定位：给「不接应用配置层」的调用方一个能直接跑起来的缺省清单（demo / 测试 / 最小工作台）。
// 判据：这里只是**数据**，不是真源 —— 宿主的模型目录（可用账号、价目、可见性）永远优先，
// 本目录既不合并、也不覆盖它。已知 id 用 `findModel`，未知 id 原样透传上游即可。

import type { ModelInfo } from './types.js';

/** 缺省模型 id（配置里没指定时用它） */
export const DEFAULT_MODEL_ID = 'deepseek-v4-flash';

/**
 * 静态目录（3 条，够演示「选模型」这一步；价目单位 $/1M tokens，未定价的桶不写）。
 * ⚠️ 数据是示例性质的先验，别拿它当计费依据 —— 计费真源在宿主侧。
 */
export const DEFAULT_MODELS: readonly ModelInfo[] = [
    {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 128_000,
        cost: { input: 0.28, output: 0.42, cacheRead: 0.028 },
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 128_000,
        cost: { input: 0.56, output: 1.68, cacheRead: 0.056 },
    },
    {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        contextWindow: 128_000,
        cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    },
];

/** 按 id 查目录里的条目；不在目录里 = undefined（不是错误：未知 id 交给上游判） */
export function findModel(id: string, catalog: readonly ModelInfo[] = DEFAULT_MODELS): ModelInfo | undefined {
    return catalog.find((model) => model.id === id);
}
