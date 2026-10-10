// src/shared/models.ts
// 🎯 运行时模型目录 + 查询函数（纯数据 + 纯函数，无 node 依赖）。
//
// 数据来源（见 main/core/model-runtime.ts）：snapshot（models.dev 白名单产物）⊕ custom spec
// ⊕ $DIY_HOME/model.yaml（账号/可见性/覆盖）。进程启动 / 配置保存后把解析结果**灌进本模块的
// 可变目录**（setModelCatalog），此后一切查询（apiOf/contextLimitOf/costOf/…）都走它。
//
// **没有内置 provider**：无任何已配置 provider → 目录为空（模型元数据全部来自
// snapshot ⊕ custom spec，代码里不硬编码任何模型清单）。应用首次启动是空的，用户添加
// provider + 账号后才列出可用模型。
//
// 约定：本文件禁止 import node:*（renderer 会打进包）。

import { ratesOf, type EffectiveRates, type ModelCost } from "./usage";

/**
 * 模型走的 API 面。**由 npm 字段解析**（provider 级 `npm` 默认 + 模型级 `provider.npm` 覆写）：
 *   `@ai-sdk/openai-compatible` → chat（POST {baseUrl}/chat/completions）
 *   `@ai-sdk/openai`            → responses（POST {baseUrl}/responses）
 * 这与 models.dev 完全对齐（opencode-go 等混面 provider 靠模型级 npm 覆写表达）。
 */
export type LocalModelApi = "chat" | "responses";

/** npm 包名 → API 面白名单。只认这两家；其余 npm 的 provider/模型不进 registry。 */
export const NPM_FACE: Record<string, LocalModelApi> = {
    "@ai-sdk/openai-compatible": "chat",
    "@ai-sdk/openai": "responses",
};

/** 解析 npm → 面；不支持的 npm → null（该 provider/模型不出现） */
export function faceOfNpm(npm: string | undefined | null): LocalModelApi | null {
    return npm ? (NPM_FACE[npm] ?? null) : null;
}

/** 推理强度档位：开放字符串（各模型词表不同） */
export type ReasoningEffort = string;

/** 模型能力的登记（spec 的 reasoning_options ⊕ 配置覆盖） */
export interface LocalModelReasoning {
    supported: ReasoningEffort[];
    default: ReasoningEffort;
}

/** 模型元数据（= spec ⊕ 覆盖；不含连接信息） */
export interface LocalModel {
    id: string;
    name: string;
    /** chat = /chat/completions（@ai-sdk/openai-compatible）；responses = /responses（@ai-sdk/openai） */
    api: LocalModelApi;
    /** 上下文窗口（tokens）；spec 未提供 → undefined（运行时按"无预算"处理） */
    contextLimit?: number;
    /** 单次输出上限（tokens）；spec 未提供 → undefined（运行时回退 DEFAULT_LIMITS.maxOutputTokens） */
    maxOutputTokens?: number;
    reasoning: LocalModelReasoning;
    /** 单价（$/1M tokens，真源 models.dev，抓取日期见 MODEL_COST_AS_OF）；缺失 = 无价目，不算钱 */
    cost?: ModelCost;
    /**
     * 提示词缓存的**存活时长**（ms）—— 官方一律不给这个数字（只能实测夹逼）。
     * 用途：判断"距上次请求这么久 → 缓存已过期（expired）→ 此刻压缩零重建代价"（##269 自动压缩）。
     * ⚠️ 填的是**先验**（缺省 1 小时），真正的判据是**从 usage 实测回归出来的区间**。
     */
    cacheTtlMs?: number;
}

/**
 * 运行时可解析模型 = 元数据 + 连接路由。**运行时唯一查询对象**。
 * `ref` = 完全限定名 `account@provider/model`（见 shared/model-config.ts splitQualified）。
 */
export interface ResolvedModel extends LocalModel {
    /** 完全限定名：`0@opencode-go/gpt-5.6-luna` */
    ref: string;
    /** provider 段（std = models.dev id；custom = `custom:<key>`） */
    provider: string;
    kind: "std" | "custom";
    /** 账号名（限定名 `@` 前段） */
    account: string;
    /** baseUrl（spec.api） */
    baseUrl: string;
    /** ai-sdk 包名（spec/provider.npm 解析结果） */
    npm: string;
    /** 展开后的 apiKey；null = 未配置/展开失败（运行时 fail-fast） */
    key: string | null;
}

/**
 * 缓存 TTL 的**先验缺省**：1 小时。官网不提供该数字，必须有个兜底；
 * 实测区间会把它夹紧（见 shared/context/cache-ttl）。
 */
export const CACHE_TTL_PRIOR_MS = 60 * 60 * 1000;

/** 保留 3 位小数（账目数字：浮点残渣只会让人以为是 bug） */
export function round3(x: number): number {
    return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x;
}

/**
 * 价格表抓取日期。**单价会变**：金额落盘时要把这份日期一起写进快照，
 * 否则日后翻旧账会拿新单价去解释旧消耗（##211 §四.4.6）。
 */
export const MODEL_COST_AS_OF = "2026-10-02";

// ── 可变目录（main 侧 model-runtime 灌入；无 provider 配置 = 空） ──

let _catalog: ResolvedModel[] = [];

/** 灌入运行时目录（main 启动 / 改配置后调用）。**不回退内置**：无 provider 就是空。 */
export function setModelCatalog(models: ResolvedModel[]): void {
    _catalog = models;
}

/** 当前运行时目录（UI 模型列表 / CLI 用） */
export function getModelCatalog(): ResolvedModel[] {
    return _catalog;
}

/**
 * 按**完全限定名**或**裸模型 id** 查模型。
 * 裸 id 命中多个**不同 provider** → undefined（歧义，调用方报错；不猜）。
 * 同 provider 多账号命中同一 id → 返回首个（元数据一致，账号差异由调用方按 ref 指定）。
 */
export function findModel(refOrId: string): ResolvedModel | undefined {
    const exact = _catalog.find((m) => m.ref === refOrId);
    if (exact) return exact;
    const hits = _catalog.filter((m) => m.id === refOrId);
    if (hits.length === 0) return undefined;
    return new Set(hits.map((h) => h.provider)).size === 1 ? hits[0] : undefined;
}

/** 按 model id 查 API 面；未知模型按 chat 处理（不静默换面） */
export function apiOf(modelId: string): LocalModelApi {
    return findModel(modelId)?.api ?? "chat";
}

/** 按 model id 查推理能力；未知模型回退成「平台默认」（不发送档位，不静默给档位） */
export function reasoningOf(modelId: string): LocalModelReasoning {
    return findModel(modelId)?.reasoning ?? { supported: ["default"], default: "default" };
}

/** 按 model id 查上下文窗口（tokens）；未知返回 undefined（预算回退到硬上限） */
export function contextLimitOf(modelId: string): number | undefined {
    return findModel(modelId)?.contextLimit;
}

/** 按 model id 查 maxOutputTokens；未知返回 undefined（调用方决定 fallback） */
export function maxOutputTokensOf(modelId: string): number | undefined {
    return findModel(modelId)?.maxOutputTokens;
}

/**
 * 生效输出上限：spec 给了**正值**就用，否则回退 `fallback`。**保证返回 >= 1**。
 *
 * 为什么必须钳：`streamText({ maxOutputTokens })` 传 0/负数会被 SDK 直接拒
 * （"maxOutputTokens must be >= 1"，##184 实测）。spec 未给 limit.output 的模型
 * （如 commandcode 的 /models 只给 context_length）就走 fallback，绝不下发 0。
 */
export function effectiveMaxOutputTokens(modelId: string, fallback: number): number {
    const n = maxOutputTokensOf(modelId);
    return n !== undefined && n >= 1 ? n : fallback;
}

/** 某模型的缓存 TTL 先验（缺省见 CACHE_TTL_PRIOR_MS） */
export function cacheTtlMsOf(modelId: string): number {
    return findModel(modelId)?.cacheTtlMs ?? CACHE_TTL_PRIOR_MS;
}

/**
 * 取**生效单价**（含选中 tier）；模型不在表里或表中无价 → null（调用方决定怎么提示）。
 * tier 按「总输入 token」选（含缓存读/写），取满足条件的最大阈值 —— 见 shared/usage.ts。
 */
export function costOf(modelId: string, promptTokens: number): EffectiveRates | null {
    return ratesOf(findModel(modelId)?.cost, promptTokens);
}

/** 该 id 是否在清单内（persona 校验用：写配置时就拦住打错的模型名） */
export function isKnownModel(modelId: string): boolean {
    return modelId.length > 0 && findModel(modelId) !== undefined;
}
