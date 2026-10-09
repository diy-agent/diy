// src/shared/models.ts
// 🎯 可选模型清单的**运行时目录 + 查询函数**（纯数据 + 纯函数，无 node 依赖）。
//
// 数据来源（见 main/core/model-runtime.ts）：snapshot（models.dev 白名单产物）⊕ custom spec
// ⊕ $DIY_HOME/model.yaml（账号/可见性/覆盖）。进程启动时把解析结果 **灌进本模块的可变目录**
// （`setModelCatalog`），此后一切查询（apiOf/contextLimitOf/costOf/…）都走它。
//
// 为什么本文件是可变的：main 侧的注册表要读盘（snapshot 4.3MB + yaml），而 core/persona
// 在写配置时就要「模型是否已知 / 档位集」，renderer 也要档位集 —— 三方共用同一份内存目录
// 是最省摩擦的做法（core 不能反向依赖 services，否则循环 import）。缺省目录 = 内置 zen/go，
// 保证「未配置任何 provider」时系统仍可用（开箱即用 + 单测不依赖磁盘）。
//
// 约定：本文件禁止 import node:*（renderer 会打进包）。

import { ratesOf, type EffectiveRates, type ModelCost } from "./usage";

/**
 * 内置缺省模型（完全限定名）。
 *
 * 为什么指向 `mimo-v2.6-flash`（用户 2026-10-06）：它是全表最便宜的带工具模型
 * （$0.14 / $0.28 per 1M），而**并行任务多、费用易失控**时默认值必须是最省的那个
 * —— 用户原话「当前系统的费用失控」「不要用 luna」。要贵的模型请显式选（人物）。
 * 另见 `~/git/diy/diy/AGENTS.md` 的 `model.default` 约定（测试同样只准便宜档）。
 */
export const DEFAULT_MODEL = "0@opencode-go/mimo-v2.6-flash";

/** zen/go 基址：两个 API 面共用（chat/completions 与 responses 只是路径不同） */
export const ZEN_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * **实际服务的上游名**（兜底；运行时以 resolved.provider 为准）。
 * 与价目真源（`COST_SOURCE` = models.dev）是两件事：这是"请求走了谁"，那是"单价查的哪张表"。
 */
export const UPSTREAM_PROVIDER = "opencode-go";

/**
 * 模型走的 API 面。**必须逐个模型标注**，因为 zen/go 的 `GET /models` 不返回 API 面信息
 * （只有 id/object/created/owned_by），标错的表现是「上游 503 Endpoint is unavailable」：
 * responses-only 模型打到 /chat/completions 一律 503（gpt-5.6-luna / gpt-6-luna 2026-09-24 实测）。
 * 真源：pi 的 ~/.pi/agent/models-store.json 的 `api` 字段（opencode-go provider）。
 */
export type LocalModelApi = "chat" | "responses";

/** 推理强度档位：开放字符串（各模型词表不同，见 BUILTIN_MODELS 的 reasoning） */
export type ReasoningEffort = string;

/** 模型能力的临时手工登记；待模型管理功能接入后由远端配置替换。 */
export interface LocalModelReasoning {
    supported: ReasoningEffort[];
    default: ReasoningEffort;
}

/** 模型元数据（= spec ⊕ 覆盖的白名单字段；不含连接信息） */
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
    /** ai-sdk 包名（spec.npm） */
    npm: string;
    /** 展开后的 apiKey；null = 未配置/展开失败（运行时 fail-fast） */
    key: string | null;
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

/**
 * 价格表抓取日期。**单价会变**：金额落盘时要把这份日期一起写进快照，
 * 否则日后翻旧账会拿新单价去解释旧消耗（##211 §四.4.6）。
 */
export const MODEL_COST_AS_OF = "2026-10-02";

/**
 * 内置模型（zen/go = models.dev 的 `opencode-go` provider，2026-09-24 实查）。
 * 价格单位为 $/1M tokens：input / output（cacheRead）
 *
 * `reasoning.supported` 的真源是**上游自己的校验报错**（2026-09-24 逐模型探测）：
 * 给 `reasoning_effort`（chat 面）/ `reasoning.effort`（responses 面）发一个非法值，
 * 上游回 400 并列出 expected one of ...，再逐值实测确认 200 / 400。
 * 实测差异：deepseek-v4.1-flash 多一个 `ultra` 档；两个 luna 都无 `minimal`；
 * mimo-v2.6-flash 只认 none/low/medium/high（minimal/xhigh/max 一律 400 Invalid request parameters）。
 */
export const BUILTIN_MODELS: LocalModel[] = [
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", api: "chat", contextLimit: 1048576, maxOutputTokens: 131072 , reasoning: { supported: ["none", "low", "medium", "high"], default: "medium" }, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, cacheTtlMs: CACHE_TTL_PRIOR_MS },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "chat", contextLimit: 1000000, maxOutputTokens: 384000 , reasoning: { supported: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"], default: "medium" }, cost: { input: 0.15, output: 0.6, cacheRead: 0.003 }, cacheTtlMs: CACHE_TTL_PRIOR_MS },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" }, cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, tiers: [{ above: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }] }, cacheTtlMs: CACHE_TTL_PRIOR_MS },
    { id: "gpt-6-luna", name: "GPT 6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" }, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ above: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }, cacheTtlMs: CACHE_TTL_PRIOR_MS }
];

/** 内置模型 → 目录项（provider = opencode-go，账号 0，key 走 `$OPENCODE_API_KEY`） */
export const BUILTIN_CATALOG: ResolvedModel[] = BUILTIN_MODELS.map((m) => ({
    ...m,
    ref: `0@opencode-go/${m.id}`,
    provider: "opencode-go",
    kind: "std" as const,
    account: "0",
    baseUrl: ZEN_BASE_URL,
    npm: "@ai-sdk/openai-compatible",
    key: "$OPENCODE_API_KEY",
}));

/** 兼容旧名（历史引用路径：tests/…/local-models-*.test.ts）：内置清单 = 缺省目录的元数据 */
export const LOCAL_MODELS: LocalModel[] = BUILTIN_MODELS;

// ── 可变目录（main 侧 model-runtime 灌入；缺省 = 内置） ──

let _catalog: ResolvedModel[] = BUILTIN_CATALOG;

/** 灌入运行时目录（main 启动 / 改配置后调用）。传空数组 = 回退内置。 */
export function setModelCatalog(models: ResolvedModel[]): void {
    _catalog = models.length > 0 ? models : BUILTIN_CATALOG;
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

/**
 * responses-only 模型名单（内置知识）。models.dev 的 `npm` 是 provider 级的粗定面，
 * 无法表达「同 provider 少数模型走 responses」—— 如 zen/go 的这两个（打 chat 面必 503）。
 * API 面真源 = 逐模型覆盖（ModelOverride.api）> 本名单 > chat 缺省。
 */
export const RESPONSES_ONLY_MODELS = new Set(["gpt-5.6-luna", "gpt-6-luna"]);

/** 生效 API 面：逐模型覆盖 > 内置 responses 名单 > chat */
export function defaultApiFace(id: string, override?: LocalModelApi): LocalModelApi {
    return override ?? (RESPONSES_ONLY_MODELS.has(id) ? "responses" : "chat");
}

/** 按 model id 查 API 面；未知模型按 chat 处理（保持历史行为，不静默换面） */
export function apiOf(modelId: string): LocalModelApi {
    return findModel(modelId)?.api ?? "chat";
}

/** 按 model id 查推理能力；未知模型回退成「只能关闭」（不静默给档位） */
export function reasoningOf(modelId: string): LocalModelReasoning {
    return findModel(modelId)?.reasoning ?? { supported: ["none"], default: "none" };
}

/** 按 model id 查上下文窗口（tokens）；未知返回 undefined（预算回退到硬上限） */
export function contextLimitOf(modelId: string): number | undefined {
    return findModel(modelId)?.contextLimit;
}

/** 按 model id 查 maxOutputTokens；未知返回 undefined（调用方决定 fallback） */
export function maxOutputTokensOf(modelId: string): number | undefined {
    return findModel(modelId)?.maxOutputTokens;
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
    return findModel(modelId) !== undefined;
}
