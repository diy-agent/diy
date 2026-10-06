// src/shared/models.ts
// 🎯 可选模型清单（zen/go）的**单一真相源**：纯数据 + 纯函数，无 node 依赖。
//
// 为什么独立于 local-agent（服务实现）：
//   persona（agent 人物）在 core 层就要用到「默认模型」「模型能力查询」，而 core 不能被
//   services 反向依赖（否则 core/persona ↔ services/local-agent 循环 import，常量初始化
//   顺序会拿到 undefined）。清单本身是配置数据、不是协议实现，放 shared 是正确归属。
//
// 约定：本文件禁止 import node:*（renderer 会打进包）。

import { ratesOf, type EffectiveRates, type ModelCost } from "./usage";

/**
 * 缺省模型。
 *
 * 为什么是 `mimo-v2.6-flash`（用户 2026-10-06）：它是全表最便宜的带工具模型
 * （$0.14 / $0.28 per 1M），而**并行任务多、费用易失控**时默认值必须是最省的那个
 * —— 用户原话「当前系统的费用失控」「不要用 luna」。要贵的模型请显式选（人物）。
 * 另见 `~/git/diy/diy/AGENTS.md` 的 `model.default` 约定（测试同样只准便宜档）。
 */
export const DEFAULT_MODEL = "mimo-v2.6-flash";

/** zen/go 基址：两个 API 面共用（chat/completions 与 responses 只是路径不同） */
export const ZEN_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * **实际服务的上游名**（ai-sdk provider 名，与 `createOpenAICompatible({ name })` 一致）。
 * 与价目真源（`COST_SOURCE` = models.dev）是两件事：这是"请求走了谁"，那是"单价查的哪张表"。
 * 落账本时两个都要有（##230 实测：同一模型不同 provider 报价差 1x~50x）。
 */
export const UPSTREAM_PROVIDER = "zen-go";

/**
 * 模型走的 API 面。**必须逐个模型标注**，因为 zen/go 的 `GET /models` 不返回 API 面信息
 * （只有 id/object/created/owned_by），标错的表现是「上游 503 Endpoint is unavailable」：
 * responses-only 模型打到 /chat/completions 一律 503（gpt-5.6-luna / gpt-6-luna 2026-09-24 实测）。
 * 真源：pi 的 ~/.pi/agent/models-store.json 的 `api` 字段（opencode-go provider）。
 */
export type LocalModelApi = "chat" | "responses";

/** 推理强度档位：开放字符串（各模型词表不同，见 LOCAL_MODELS 的 reasoning） */
export type ReasoningEffort = string;

/** 模型能力的临时手工登记；待模型管理功能接入后由远端配置替换。 */
export interface LocalModelReasoning {
    supported: ReasoningEffort[];
    default: ReasoningEffort;
}

export interface LocalModel {
    id: string;
    name: string;
    /** chat = /chat/completions（@ai-sdk/openai-compatible）；responses = /responses（@ai-sdk/openai） */
    api: LocalModelApi;
    contextLimit: number;
    maxOutputTokens: number;
    reasoning: LocalModelReasoning;
    /** 单价（$/1M tokens，真源 models.dev，抓取日期见 MODEL_COST_AS_OF）；缺失 = 无价目，不算钱 */
    cost?: ModelCost;
    /**
     * 提示词缓存的**存活时长**（ms）—— 官方一律不给这个数字（只能实测夹逼）。
     * 用途：判断"距上次请求这么久 → 缓存已过期（expired）→ 此刻压缩零重建代价"（##269 自动压缩）。
     * ⚠️ 填的是**先验**（缺省 1 小时），真正的判据是**从 usage 实测回归出来的区间**
     * （见共享模块 cache-ttl：`ttl ∈ (aliveUpTo, deadFrom]`）——别把这个常数当真理。
     */
    cacheTtlMs?: number;
}

/**
 * 缓存 TTL 的**先验缺省**：1 小时。
 * 为什么写它而不是留空：判"缓存是否过期"必须有个兜底（官网不提供数字），
 * 而且 1 小时是各家公开档位里最常见的量级；实测区间会把它夹紧（见 shared/context/cache-ttl）。
 */
export const CACHE_TTL_PRIOR_MS = 60 * 60 * 1000;

/** 保留 3 位小数（账目数字：浮点残渣如 50.00000000000001 只会让人以为是 bug） */
export function round3(x: number): number {
    return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x;
}

/** 某模型的缓存 TTL 先验（缺省见 CACHE_TTL_PRIOR_MS） */
export function cacheTtlMsOf(modelId: string): number {
    return LOCAL_MODELS.find((m) => m.id === modelId)?.cacheTtlMs ?? CACHE_TTL_PRIOR_MS;
}

/**
 * 价格表抓取日期。**单价会变**：金额落盘时要把这份日期一起写进快照，
 * 否则日后翻旧账会拿新单价去解释旧消耗（##211 §四.4.6）。
 */
export const MODEL_COST_AS_OF = "2026-10-02";

/**
 * 可选模型（2026-09-24 实查 /models + models.dev 价格 + 两个 API 面逐个 curl 验证）
 * 价格单位为 $/1M tokens：input / output（cacheRead）
 *
 * `reasoning.supported` 的真源是**上游自己的校验报错**（2026-09-24 逐模型探测）：
 * 给 `reasoning_effort`（chat 面）/ `reasoning.effort`（responses 面）发一个非法值，
 * 上游回 400 并列出 expected one of ...，再逐值实测确认 200 / 400。
 * 实测差异：deepseek-v4.1-flash 多一个 `ultra` 档；两个 luna 都无 `minimal`；
 * mimo-v2.6-flash 只认 none/low/medium/high（minimal/xhigh/max 一律 400 Invalid request parameters）。
 * 注意：这与 pi 的 `thinkingLevelMap` 不同源 —— 那张表是「pi 档位 → 上游 thinking 字段」的映射，
 * 对直传 reasoning_effort 的 diy 不适用（pi 隐藏的档位在 diy 路径上实测有效）。
 */
export const LOCAL_MODELS: LocalModel[] = [
    // maxOutputTokens / contextLimit 来源：models.dev/api.json 的 limit.output / limit.context（2026-09 实查，
    // 取 opencode-go 或同名模型主 provider 的值）。contextLimit 用于推导系统上下文预算（见 prompt-registry）。
    // 排列顺序 = UI 平铺按钮的展示顺序，按**价格从低到高**（便宜的先看见）。
    // 注意：首项**不再**等于内置默认 persona 的模型（DEFAULT_MODEL）—— 模型选择已归 persona，
    // 界面/代码都不该再"取列表首项当默认"（那正是"看着一个模型、用的是另一个"的来源）。
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", api: "chat", contextLimit: 1048576, maxOutputTokens: 131072 , reasoning: { supported: ["none", "low", "medium", "high"], default: "medium" }, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, cacheTtlMs: CACHE_TTL_PRIOR_MS },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "chat", contextLimit: 1000000, maxOutputTokens: 384000 , reasoning: { supported: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"], default: "medium" }, cost: { input: 0.15, output: 0.6, cacheRead: 0.003 }, cacheTtlMs: CACHE_TTL_PRIOR_MS },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" }, cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, tiers: [{ above: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }] }, cacheTtlMs: CACHE_TTL_PRIOR_MS },
    { id: "gpt-6-luna", name: "GPT 6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" }, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ above: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }, cacheTtlMs: CACHE_TTL_PRIOR_MS }
];

/** 按 model id 查 API 面；未知模型按 chat 处理（保持历史行为，不静默换面） */
export function apiOf(modelId: string): LocalModelApi {
    return LOCAL_MODELS.find(m => m.id === modelId)?.api ?? "chat";
}

/** 按 model id 查推理能力；未知模型回退成「只能关闭」（不静默给档位） */
export function reasoningOf(modelId: string): LocalModelReasoning {
    return LOCAL_MODELS.find(m => m.id === modelId)?.reasoning ?? { supported: ["none"], default: "none" };
}

/** 按 model id 查上下文窗口（tokens）；未知返回 undefined（预算回退到硬上限） */
export function contextLimitOf(modelId: string): number | undefined {
    return LOCAL_MODELS.find(m => m.id === modelId)?.contextLimit;
}

/** 按 model id 查 maxOutputTokens；未知返回 undefined（调用方决定 fallback） */
export function maxOutputTokensOf(modelId: string): number | undefined {
    return LOCAL_MODELS.find(m => m.id === modelId)?.maxOutputTokens;
}

/**
 * 取**生效单价**（含选中 tier）；模型不在表里或表中无价 → null（调用方决定怎么提示）。
 * tier 按「总输入 token」选（含缓存读/写），取满足条件的最大阈值 —— 见 shared/usage.ts。
 */
export function costOf(modelId: string, promptTokens: number): EffectiveRates | null {
    return ratesOf(LOCAL_MODELS.find(m => m.id === modelId)?.cost, promptTokens);
}

/** 该 id 是否在清单内（persona 校验用：写配置时就拦住打错的模型名） */
export function isKnownModel(modelId: string): boolean {
    return LOCAL_MODELS.some(m => m.id === modelId);
}
