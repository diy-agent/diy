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
import type { ChatMessage, ChatOptions, LlmPort, SessionDelta } from '@diy-agent/session';
import { classifyError } from './errors.js';
import { SESSION_PLACEHOLDER } from './strategies/opencode.js';
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
    // 静态 header 在建 provider 时固定；带 `$SESSION` 的要等每次调用的 sessionId 才知道值，单独拿出来
    const { fixed, templated } = splitHeaders(config.headers);
    const provider = createOpenAICompatible({
        name: config.name ?? 'diy-llm-provider',
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        includeUsage: true, // 流里带上 usage（不写这行，多数兼容上游不给流式用量）
        ...(Object.keys(fixed).length === 0 ? {} : { headers: fixed }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });

    return {
        model: config.model,
        chat(messages: readonly ChatMessage[], options?: ChatOptions) {
            return chatStream(
                provider.chatModel(options?.model ?? config.model),
                messages,
                options,
                sessionHeaders(templated, options?.sessionId),
            );
        },
    };
}

/**
 * 把 header 拆成「静态」与「含 `$SESSION` 占位符」两组。
 * 占位符必须在每次 chat 时才替换 —— 会话 id 是调用方逐次给的，不是建 provider 时就知道的。
 */
function splitHeaders(headers: Readonly<Record<string, string>> | undefined): {
    fixed: Record<string, string>;
    templated: Record<string, string>;
} {
    const fixed: Record<string, string> = {};
    const templated: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (value.includes(SESSION_PLACEHOLDER)) templated[key] = value;
        else fixed[key] = value;
    }
    return { fixed, templated };
}

/**
 * 本次调用要补的 header：`$SESSION` → sessionId。
 * 无 sessionId ⇒ 整条 header 不传（**不是**空字符串：空值 header 会被上游当成显式路由键）。
 */
function sessionHeaders(
    templated: Readonly<Record<string, string>>,
    sessionId: string | undefined,
): Record<string, string> | undefined {
    if (sessionId === undefined || sessionId.length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(templated)) out[key] = value.split(SESSION_PLACEHOLDER).join(sessionId);
    return Object.keys(out).length === 0 ? undefined : out;
}

/** 一次调用的流：text 增量 → usage → done；上游失败抛 `LlmProviderError` */
async function* chatStream(
    model: ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>,
    messages: readonly ChatMessage[],
    options: ChatOptions | undefined,
    headers: Record<string, string> | undefined,
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
            ...(headers === undefined ? {} : { headers }),
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
                case 'tool-call': {
                    const delta = toolCallDeltaOf(part);
                    if (delta !== undefined) yield delta;
                    break;
                }
                case 'tool-result': {
                    const delta = toolResultDeltaOf(part);
                    if (delta !== undefined) yield delta;
                    break;
                }
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
                    // 其余 part（reasoning / source / start-step / finish-step / tool-input-* …）本刀不消费。
                    //
                    // ⚠️ 工具调用只在 **`tool-call`（完整调用）** 上产出，**不在 `tool-input-start` /
                    // `tool-input-delta` 上产出**：那两者是流式参数的分片信号（start 连 input 都还没有），
                    // 各自 yield 一次等于把同一次调用记成 2~3 条 tool-call 消息（session 会逐条落盘，
                    // 上层也会逐条执行 —— 重复执行工具）。判据：**一次调用只认一条完整 part**。
                    // 思考块（reasoning-delta → thinking）留给 ##514 第 4 步。
                    break;
            }
        }
    } catch (cause) {
        throw classifyError(cause);
    }
}

/**
 * ai-sdk 的 `tool-call` part → `SessionDelta`（tool-call）。
 *
 * 字段换名：ai-sdk 用 `toolCallId` / `toolName`，SessionDelta 用 `id` / `name`。
 * `input` 归一成 **JSON 字符串**（SessionDelta 的契约就是 string）：
 *   · 上游给对象（ai-sdk 已解析好的参数）→ `JSON.stringify`
 *   · 上游给原始字符串（参数不是合法 JSON 时 ai-sdk 原样透传）→ 不动，交给 session 的
 *     `toolArgsFromInput` 自行 JSON.parse / 退回字符串
 *   · 缺参数（`undefined`）→ `"null"`（与 `toolArgsFromInput(undefined) === null` 同义，但保持 string）
 *
 * 缺 id / name 的 part 直接丢：落盘后的 tool-call 消息无从回填结果，造出来只会是脏数据。
 */
export function toolCallDeltaOf(part: Record<string, unknown>): SessionDelta | undefined {
    const id = part['toolCallId'];
    const name = part['toolName'];
    if (typeof id !== 'string' || id === '') return undefined;
    if (typeof name !== 'string' || name === '') return undefined;
    return { type: 'tool-call', id, name, input: jsonTextOf(part['input']) };
}

/**
 * ai-sdk 的 `tool-result` part → `SessionDelta`（tool-result）。
 *
 * 说明：本刀 provider **不执行工具**（`streamText` 没传 `tools`，见 step 3），所以这个分支正常不会
 * 出现；它存在是为了不把已经能翻译的形状丢掉（宿主注入 `tools` 后就直接生效）。
 *
 * `output` 是 ai-sdk 的结果包（`{ type:'text'|'json'|'error-text'|'content', value }`）：
 * 文本类取 `value`；有 `value` 的其他类型（json / content）转 JSON 文本；其余整个转 JSON。
 * —— SessionDelta 只要一个字符串（怎么显示由上层决定），所以这里只做「无损转文本」。
 */
export function toolResultDeltaOf(part: Record<string, unknown>): SessionDelta | undefined {
    const id = part['toolCallId'];
    if (typeof id !== 'string' || id === '') return undefined;
    return { type: 'tool-result', id, content: toolOutputTextOf(part['output']) };
}

/** 任意值 → JSON 文本（`undefined` / 不可序列化 → `"null"`，不抛） */
function jsonTextOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'null';
    try {
        const text = JSON.stringify(value);
        return typeof text === 'string' ? text : 'null';
    } catch {
        return 'null';
    }
}

/** ai-sdk 的工具结果包 → 文本（文本类直接取，其余转 JSON，见 `toolResultDeltaOf` 头注） */
function toolOutputTextOf(output: unknown): string {
    if (typeof output === 'string') return output;
    if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
        const record = output as Record<string, unknown>;
        const value = record['value'];
        const kind = record['type'];
        if (typeof value === 'string' && (kind === 'text' || kind === 'error-text')) return value;
        if (value !== undefined) return jsonTextOf(value);
    }
    return jsonTextOf(output);
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
