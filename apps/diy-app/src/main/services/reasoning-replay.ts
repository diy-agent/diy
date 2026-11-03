// src/main/services/reasoning-replay.ts
// 🎯 投递前归一：thinking 模式下回放的 assistant 消息**必须带 `reasoning_content`**（##398）
//
// 上游铁律（DeepSeek thinking 模式，luminal 端点必校验）：
//   `[invalid_request_error] The reasoning_content in the thinking mode must be passed back to the API.`
// ⇒ 历史里只要有一条 assistant（尤其带 `tool_calls` 的那种）**没有**推理内容，整个请求 400、
//   这一轮直接死掉（干到一半的活白干）。代价远大于「补一个空串」。
//
// 两个半修：
//   · ##371 修的是「**有** think 块 ⇒ 挂成 reasoning part」；
//   · 本文件修的是「**这一步压根没有 think 块**」—— 上游不吐 reasoning delta 是常态
//     （实测 ##266 的 4024 条 assistant 里 1264 条 = 31% 无 reasoning），此时
//     `projectAll` 没有可挂的 part，`@ai-sdk/openai-compatible` 的 assistant 分支见
//     `reasoning.length > 0` 为 false ⇒ wire 上**连字段都不出现** ⇒ 命中严判端点即 400。
//
// 通道：`@ai-sdk/openai-compatible` 把**消息级** `providerOptions.openaiCompatible`
// 整对象透传到 wire（`dist/index.js` 的 `getOpenAIMetadata`；assistant 分支在
// `reasoning_content` 之后 `...metadata` 展开）。所以给缺推理的 assistant 消息挂
// `{ openaiCompatible: { reasoning_content: "" } }` 就能让字段出现在 wire 上，
// 而**有推理的**那些照旧由 SDK 自己的 `reasoning_content` 输出（实测不被 metadata 覆盖）。
//
// 为什么是「补空串」而不是「伪造推理」：空串 = 「这一步没有思考」，是**事实**；
// 编造推理内容会污染模型的自我上下文。opencode / pi 两家对 deepseek 做的也是这条兜底
// （opencode `requireReasoning` 缺则补 ""，pi `requiresReasoningContentOnAssistantMessages`）。
//
// ⚠️ **轮内每一步都要跑**（##405）：首步之外，SDK 送上来的 assistant 是它用响应重建的，
//   不带 providerOptions —— 只跑首步等于没修（实测同一轮第 1~84 步全 200、第 85 步 400）。
//   调用点两处：首步（runTurn 的 `sent`）+ `prepareStep` 每步（同一个 `replayOpts`）。
//
// 铁律（不许破）：**只加 providerOptions，不加 part、不加消息** —— 消息条数与下标
// 必须继续等于 llm.jsonl 行号（##371 定下的对齐语义，压缩注记 / 预览 / 记账全靠它）。
import type { ModelMessage } from "ai";

/** 归一的开关判据（两个都为 true 才动手） */
export interface ReasoningReplayOpts {
    /** 本次请求是 thinking 模式（档位非 none 且模型支持该档位） */
    thinking: boolean;
    /** 目标模型 / 供应商是 deepseek 系（空串是否被接受的唯一已知证据面，见下 `isDeepSeekWire`） */
    deepseek: boolean;
}

/** wire 侧的身份三元组（provider 名 / 模型 id / baseUrl）—— 判「是不是 deepseek」 */
export interface WireIdentity {
    provider?: string;
    model?: string;
    baseUrl?: string;
}

/**
 * 是不是 deepseek 系（决定要不要补空串）。照抄 opencode / pi 的收窄判据：
 *   · opencode：`provider === "deepseek"` ∨ baseURL 含 `deepseek.com` ∨ **modelID 含 `deepseek`**
 *   · pi：`provider 或 baseURL 含 deepseek`
 * 三者取并（任一项含 `deepseek` 即算）。
 *
 * ⚠️ **不要擅自放宽到「所有 reasoning 模型」**：空串是否被接受只在 deepseek 系上有证据
 * （##371 / ##374 的实测都是 dsv4.1）；glm / 其它 reasoning 模型没验过，补空串可能反过来
 * 被判非法（有的上游要求 reasoning_content 为 null 或干脆不收）。
 */
export function isDeepSeekWire(w: WireIdentity): boolean {
    return [w.provider, w.model, w.baseUrl].some((v) => typeof v === "string" && v.toLowerCase().includes("deepseek"));
}

/** assistant 消息是否已经带真推理（有就绝不覆盖） */
function hasReasoningPart(m: Extract<ModelMessage, { role: "assistant" }>): boolean {
    const parts = m.content;
    return typeof parts === "string" ? false : parts.some((p) => p.type === "reasoning");
}

/**
 * 这条 assistant 是否**已经**带上 wire 侧的 `reasoning_content`（真推理由 part 承载，这里只看 metadata）。
 *
 * 为什么要单独判：本函数现在**每一步**都跑（prepareStep，见 ##405），不判会把「上一轮补过的空串」
 * 当成"还没补"再补一遍 ⇒ 每次返回新数组 ⇒ SDK 视为 messages 被替换。内容虽相同，
 * 但「无变化就返回同一引用」这条契约会被打破（幂等是调用方判「要不要覆盖」的唯一依据）。
 */
function hasReplayMarker(m: Extract<ModelMessage, { role: "assistant" }>): boolean {
    const compat = (m.providerOptions as Record<string, Record<string, unknown>> | undefined)?.["openaiCompatible"];
    return typeof compat?.["reasoning_content"] === "string";
}

/**
 * 投递前归一：给「缺 reasoning 的 assistant 消息」挂 `providerOptions.openaiCompatible.reasoning_content = ""`。
 *
 * 三态（单测钉住）：
 *   · `!thinking` 或 `!deepseek` ⇒ **原样返回**（同一个数组引用，连浅拷贝都不做）；
 *   · 有 reasoning part         ⇒ 这条**不动**（覆盖 = 把真思考换成空串，比 400 更糟）；
 *   · 无 reasoning part         ⇒ 这条补空串（`providerOptions` 合并，不丢既有键）。
 *
 * 条数 / 顺序 / 下标全不变 —— 只改单条消息的一个可选字段。
 */
export function ensureReasoningReplay(msgs: readonly ModelMessage[], opts: ReasoningReplayOpts): ModelMessage[] {
    const src = msgs as ModelMessage[];
    if (!opts.thinking || !opts.deepseek) return src;
    let patched = false;
    const out = src.map((m) => {
        if (m.role !== "assistant") return m;
        if (hasReasoningPart(m) || hasReplayMarker(m)) return m;
        patched = true;
        const prev = (m.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
        const prevCompat = (prev["openaiCompatible"] ?? {}) as Record<string, unknown>;
        return {
            ...m,
            // 只动 openaiCompatible 这一个命名空间，其它 provider 的选项原样保留
            providerOptions: { ...prev, openaiCompatible: { ...prevCompat, reasoning_content: "" } },
        } as ModelMessage;
    });
    return patched ? out : src;
}
