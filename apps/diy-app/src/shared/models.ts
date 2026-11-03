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

import type { CalendarTable } from "./calendars";
import { splitQualified } from "./model-config";
import { ratesOf, type EffectiveRates, type ModelCost, type PriceBasis } from "./usage";

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

// ── 日历表（同上：main 侧装配时灌入；时段价的日历判定用它） ──

let _calendars: CalendarTable = {};

/** 灌入内置日历表（main 启动 / 装配模型目录时调用）；未灌 = 空表（时段档全不命中） */
export function setCalendarCatalog(calendars: CalendarTable): void {
    _calendars = calendars;
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
 * 上游回执的模型标识 → 候选模型 id（**先精确后宽松**，去重；匹配到第一个即止，不猜）。
 *
 * 回执给什么**不由我们决定**，实测三种形状都出现过（##372 取证）：
 *   · 裸 id            `deepseek-v4.1-flash`
 *   · vendor 前缀 id   `deepseek/deepseek-v4.1-flash`（目录里存的是 `deepseek-v4.1-flash`）
 *   · 完全限定名       `0@opencode-go/deepseek-v4.1-flash`（目录里 id 是第三段）
 * 故逐级剥壳：原样 → 去限定段（`acc@prov/x` → `x`）→ 去 vendor 前缀（`vendor/id` → `id`）。
 * 原样排第一是关键：catalog 里自带 `/` 的 id（如 `xiaomi/mimo-v2.6-flash`）必须优先命中它自己。
 */
export function respondedIdCandidates(responded: string | null | undefined): string[] {
    const s = (responded ?? "").trim();
    if (!s) return [];
    const out: string[] = [];
    const push = (v: string): void => {
        if (v && !out.includes(v)) out.push(v);
    };
    push(s);
    const q = splitQualified(s);
    if (q) {
        push(q.model);
        const j = q.model.lastIndexOf("/");
        if (j > 0) push(q.model.slice(j + 1));
    } else {
        const i = s.lastIndexOf("/");
        if (i > 0) push(s.slice(i + 1));
    }
    return out;
}

/** provider 域内按 id 查；同 provider 多账号 → 优先本账号，否则首个（元数据一致，见 findModel 头注） */
function findInProvider(provider: string, id: string, account?: string): ResolvedModel | undefined {
    const hits = _catalog.filter((m) => m.provider === provider && m.id === id);
    if (hits.length === 0) return undefined;
    if (account !== undefined) {
        const own = hits.find((m) => m.account === account);
        if (own) return own;
    }
    return hits[0];
}

/** 一步计价用了哪个模型（诊断 + 账本留痕） */
export interface PricedModel {
    /** 用于查价的模型；undefined = 目录里查不到（调用方落 null，**不得当 0**） */
    model?: ResolvedModel;
    /**
     * 计价依据（**语义见 PriceBasis（shared/usage.ts）**，2026-10-17 用户口径后收窄）：
     *   · `response` —— 命中**上游回执**的模型（正常；上游路由改写时按实际模型计价，##211 §四.4.4）
     *   · `request`  —— 回执**根本没报模型** → 按**本请求**模型（同 provider/account，非跨家回退）
     *   · `none`     —— 其余（回执报的模型本家无报价 / 无从归属）→ **无价目**，不得回落
     */
    basis: PriceBasis;
}

/**
 * 定位**这一步按哪个模型计价**（##372）。
 *
 * 病灶：上游回执常给**裸 modelId**，而裸 id 被 ≥2 个 provider 收录时 `findModel` 判歧义 → undefined
 * → `costOf` 静默 null → 金额被当 0 累加（`deepseek-v4.1-flash` 同时被 opencode-go 与 opencode 收录，
 * 于是 opencode-go 的会话金额恒为 0）。解法：**把回执模型限定到本请求的 provider/account 再查**
 * —— 同一 id 在不同 provider 下是**不同商品**，价也可能不同，故限定的是 provider 而不是「随便挑一个」。
 *
 * **谁家的模型找谁家的价**（用户口径 2026-10-17）：因此**没有跨家回退** —— 查不到就是查不到
 * （`basis: "none"` → 调用方落 `cost: null`，UI 显示「—」），绝不拿另一个模型的价冒充、
 * 也不做「全局挑一家 provider」的猜测。
 */
export function findPricedModel(responded: string | null | undefined, requestRef: string): PricedModel {
    const req = findModel(requestRef);
    const scope = splitQualified(requestRef);
    const provider = req?.provider ?? scope?.provider;
    const account = req?.account ?? scope?.account;
    const ids = respondedIdCandidates(responded);
    // ① 按本请求的 provider 限定回执模型（唯一能解歧义的一步）。
    // 账号段一律取**本请求**的：我们就是拿它发的，回执里的 `acc@` 只是上游回声，不作准
    //（同 provider 各账号的模型元数据一致，价相同 —— 见 findModel 头注）。
    if (provider && ids.length > 0) {
        for (const id of ids) {
            const m = findInProvider(provider, id, account);
            if (m) return { model: m, basis: "response" };
        }
    }
    // ② 回执**根本没报模型**（`response.modelId` 缺）→ 按本请求模型算。
    //    这不是「回退到别家」：`req` 非空即证明请求 ref 就在目录里，价来自**同一 provider/account**，
    //    只是回执没告诉我们它用了哪个（上游改写与否无从得知，故留痕 `basis:"request"` 供事后翻账）。
    //    （实测 2026-10-17：`~/.diy` 43186 条 usage **全部**带 `responseModel`，此支目前不触发 ——
    //     留着是防「某 provider 不回显 model」时把**已知**价目误判成未知。）
    if (ids.length === 0 && req) return { model: req, basis: "request" };
    // ③ 其余一律**无价目**（两处都不许猜，用户口径 2026-10-17）：
    //    · 回执报了**另一个**模型（路由改写）而本家没收录它 —— 拿本请求模型的价顶上＝用别的东西的价冒充；
    //    · 请求 ref 连 provider 段都没有（裸 id / vendor-id 且不在目录里）—— 无从归属，
    //      全局 `findModel(id)` 等于「挑一家 provider 猜」（挑到的可能是别家），同禁。
    return { basis: "none" };
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

/**
 * 取**生效单价**（含选中档）；模型不在表里或表中无价 → null（调用方决定怎么提示）。
 *   · `tier`   = 上下文档（按总输入 token 比阈值取最大，含缓存读/写）
 *   · `window` = 时段档（按 `atMs` 请求时刻 + 内置日历判定；缺省 now）
 * 见 shared/usage.ts ratesOf。
 */
export function costOf(modelId: string, promptTokens: number, atMs?: number): EffectiveRates | null {
    return ratesOfModel(findModel(modelId), promptTokens, atMs);
}

/**
 * 生效单价（**已解析模型**版）。与 `costOf` 只差入参形状 —— 但**解过歧义的模型必须走这条**：
 * 拿 `model.ref` 再进 `costOf` 是安全的，拿裸 id 或 `model.id` 回去会**再踩一次歧义**（##372）。
 */
export function ratesOfModel(m: ResolvedModel | undefined, promptTokens: number, atMs?: number): EffectiveRates | null {
    return ratesOf(m?.cost, promptTokens, atMs, _calendars);
}

/** 该 id 是否在清单内（persona 校验用：写配置时就拦住打错的模型名） */
export function isKnownModel(modelId: string): boolean {
    return modelId.length > 0 && findModel(modelId) !== undefined;
}
