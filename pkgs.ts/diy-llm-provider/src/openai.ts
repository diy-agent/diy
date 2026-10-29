// openai.ts — OpenAI 兼容实现：ai-sdk 的 streamText → `SessionDelta` 流。
//
// 与 diy-app 同源（那边也是 `@ai-sdk/openai-compatible` + `streamText`），但**不共享代码**：
// diy-app 的调用段裹着落盘 / 块树 / 压缩 / 人设，本包只留「发请求 + 翻译流」。
//
// 三条硬边界（本文件必须守住）：
//   ① 配置全外部传入 —— 不读环境变量、不读应用数据根、不碰文件系统
//   ② 不拼提示词 —— messages 原样映射；系统提示 / 人设由调用方自己塞进 messages
//   ③ 不重试 —— `maxRetries: 0`；失败按 `LlmProviderError.code` 抛出去，由上层决定退避

import { streamText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatMessage, ChatOptions, LlmPort, SessionDelta } from '@diy/session';
import { classifyError } from './errors.js';
import type { ProviderConfig, UsageDetail } from './types.js';

/** 带缓存桶的 `usage` 增量（结构上是合法 `SessionDelta`，多带两个可选字段） */
export interface UsageDelta extends UsageDetail {
    readonly type: 'usage';
}

/** 本包产出的 provider：就是一个 `LlmPort`，外加它绑定的缺省模型 id */
export interface LlmProvider extends LlmPort {
    readonly model: string;
}

/**
 * 建一个 OpenAI 兼容 provider。
 *
 * ```ts
 * const llm = createOpenAiCompatible({
 *     baseURL: process.env["LLM_BASE_URL"]!,
 *     apiKey: process.env["LLM_API_KEY"]!,
 *     model: process.env["LLM_MODEL"] ?? DEFAULT_MODEL_ID,
 * });
 * ```
 */
export function createOpenAiCompatible(config: ProviderConfig): LlmProvider {
    requireConfig(config);
    const provider = createOpenAICompatible({
        name: config.name ?? 'diy-llm-provider',
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        includeUsage: true, // 流里带上 usage（不写这行，多数兼容上游不给流式用量）
        ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });

    return {
        model: config.model,
        chat(messages: readonly ChatMessage[], options?: ChatOptions) {
            return chatStream(provider.chatModel(options?.model ?? config.model), messages, options);
        },
    };
}

/** 一次调用的流：text 增量 → usage → done；上游失败抛 `LlmProviderError` */
async function* chatStream(
    model: ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>,
    messages: readonly ChatMessage[],
    options: ChatOptions | undefined,
): AsyncGenerator<SessionDelta> {
    let fullStream: AsyncIterable<{ type: string } & Record<string, unknown>>;
    const mapped = toModelMessages(messages);
    try {
        const result = streamText({
            model,
            // ai-sdk v7 不允许 `role: "system"` 出现在 messages 里：调用方给的 system 消息
            // 原样搬进 `system` 选项（只是换个位置，不增不改 —— 提示词仍归调用方）
            ...(mapped.system === undefined ? {} : { system: mapped.system }),
            messages: mapped.messages,
            maxRetries: 0, // 重试不归 provider（见 errors.ts 头注）
            ...(options?.signal === undefined ? {} : { abortSignal: options.signal }),
        });
        fullStream = result.fullStream as unknown as AsyncIterable<{ type: string } & Record<string, unknown>>;
    } catch (cause) {
        throw classifyError(cause);
    }

    try {
        for await (const part of fullStream) {
            switch (part.type) {
                case 'text-delta': {
                    const text = part['text'];
                    if (typeof text === 'string' && text.length > 0) yield { type: 'text', text };
                    break;
                }
                case 'error':
                    throw classifyError(part['error']);
                case 'abort':
                    yield { type: 'done', stopReason: 'aborted' };
                    return;
                case 'finish': {
                    const usage = usageOf(part['totalUsage']);
                    // 缺省 = 上游没报用量；不补 0（0 是另一个事实）
                    if (usage !== undefined) yield usageDeltaOf(usage);
                    const reason = part['finishReason'];
                    yield { type: 'done', stopReason: typeof reason === 'string' ? reason : undefined };
                    break;
                }
                default:
                    // 其余 part（reasoning / tool / source / start-step / finish-step …）本刀不消费：
                    // 工具调用与思考块留给下一刀，宁可先丢掉也不猜语义。
                    break;
            }
        }
    } catch (cause) {
        throw classifyError(cause);
    }
}

/**
 * `ChatMessage` → ai-sdk 的消息。只搬正文与角色；工具消息本刀不支持（直接跳过）。
 * system 消息单独拆出来（v7 的 messages 不接受它，见 `system` 选项）。
 */
function toModelMessages(messages: readonly ChatMessage[]): {
    system?: string;
    messages: ModelMessage[];
} {
    const systems: string[] = [];
    const out: ModelMessage[] = [];
    for (const message of messages) {
        if (message.type === 'tool-call' || message.type === 'tool-result') continue;
        if (message.role === 'tool') continue;
        const text = message.text ?? '';
        if (text.length === 0) continue;
        if (message.role === 'system') {
            systems.push(text);
            continue;
        }
        out.push({ role: message.role, content: text } as ModelMessage);
    }
    return systems.length === 0 ? { messages: out } : { system: systems.join('\n\n'), messages: out };
}

/** ai-sdk 的 `LanguageModelUsage` → 本包的 `UsageDetail`（拿不到就 undefined，不补 0） */
function usageOf(raw: unknown): UsageDetail | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as {
        inputTokens?: unknown;
        outputTokens?: unknown;
        inputTokenDetails?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
    };
    const inputTokens = tokenCount(record.inputTokens);
    const outputTokens = tokenCount(record.outputTokens);
    if (inputTokens === undefined && outputTokens === undefined) return undefined;
    const cacheReadTokens = tokenCount(record.inputTokenDetails?.cacheReadTokens);
    const cacheWriteTokens = tokenCount(record.inputTokenDetails?.cacheWriteTokens);
    return {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    };
}

function tokenCount(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function usageDeltaOf(usage: UsageDetail): SessionDelta {
    const delta: UsageDelta = { type: 'usage', ...usage };
    return delta;
}

/** 配置自证：缺 baseURL / model 是调用方的错，当场说清（别等 HTTP 400） */
function requireConfig(config: ProviderConfig): void {
    if (typeof config.baseURL !== 'string' || config.baseURL.length === 0) {
        throw new TypeError('createOpenAiCompatible: baseURL 不能为空');
    }
    if (typeof config.model !== 'string' || config.model.length === 0) {
        throw new TypeError('createOpenAiCompatible: model 不能为空');
    }
}
