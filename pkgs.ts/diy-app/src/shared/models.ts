// src/shared/models.ts
// 🎯 可选模型清单（zen/go）的**单一真相源**：纯数据 + 纯函数，无 node 依赖。
//
// 为什么独立于 local-agent（服务实现）：
//   persona（agent 人物）在 core 层就要用到「默认模型」「模型能力查询」，而 core 不能被
//   services 反向依赖（否则 core/persona ↔ services/local-agent 循环 import，常量初始化
//   顺序会拿到 undefined）。清单本身是配置数据、不是协议实现，放 shared 是正确归属。
//
// 约定：本文件禁止 import node:*（renderer 会打进包）。

export const DEFAULT_MODEL = "gpt-5.6-luna";

/** zen/go 基址：两个 API 面共用（chat/completions 与 responses 只是路径不同） */
export const ZEN_BASE_URL = "https://opencode.ai/zen/go/v1";

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
}

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
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", api: "chat", contextLimit: 1048576, maxOutputTokens: 131072 , reasoning: { supported: ["none", "low", "medium", "high"], default: "medium" } }, // 0.14 / 0.28 (0.0028)
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "chat", contextLimit: 1000000, maxOutputTokens: 384000 , reasoning: { supported: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"], default: "medium" } }, // 0.15 / 0.60 (0.003)
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" } }, // 0.20 / 1.20 (0.02)
    { id: "gpt-6-luna", name: "GPT 6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" } }, // 0.10 / 0.50 (0.01)
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

/** 该 id 是否在清单内（persona 校验用：写配置时就拦住打错的模型名） */
export function isKnownModel(modelId: string): boolean {
    return LOCAL_MODELS.some(m => m.id === modelId);
}
