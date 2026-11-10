// openai.ts — OpenAI 兼容实现：ai-sdk 的 streamText → `SessionDelta` 流。
//
// 与 diy-app 同源（那边也是 `@ai-sdk/openai-compatible` + `streamText`），但**不共享代码**：
// diy-app 的调用段裹着落盘 / 块树 / 压缩 / 人设，本包只留「发请求 + 翻译流」。
//
// 三条硬边界（本文件必须守住）：
//   ① 配置全外部传入 —— 不读环境变量、不读应用数据根、不碰文件系统
//   ② 不拼提示词 —— messages 原样映射；系统提示 / 人设由调用方自己塞进 messages
//   ③ 不重试 —— `maxRetries: 0`；失败按 `LlmProviderError.code` 抛出去，由上层决定退避

import {
    stepCountIs,
    streamText,
    type AssistantContent,
    type LanguageModel,
    type ModelMessage,
    type ToolResultPart,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { TrafficPort } from './types.js';

/** `AssistantContent` 是 `string | parts[]` 的联合；要 push 就必须用数组那一半 */
type AssistantContentParts = Exclude<AssistantContent, string>;
import type { ChatMessage, ChatOptions, LlmPort, SessionDelta } from '@diy-agent/session';
import { ensureReasoningReplay, isDeepSeekWire, type WireIdentity } from './reasoning-replay.js';
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
    /**
 * 给 fetch 包一层：每次真发之后记一条流量。
 *
 * 三条边界：
 *   · **不改请求**：`Request.clone()` 读 body，原 stream 原样放行；
 *   · **不改响应**：`Response.clone()` 同理；读 resBody 只为排查，默认截断 8KB；
 *   · **永不抛**：`traffic.push` 在 HTTP 热路径上，记日志失败不该让请求失败。
 *
 * 为什么在 fetch 这一层而不是更上层：ai-sdk 的 `streamText` 把请求体（含 system /
 * tools / messages）全在 `Request.body` 里，这是**唯一**能看到「真发了什么」的位置。
 */
function wrapFetchWithTraffic(fetchImpl: typeof globalThis.fetch, port: TrafficPort, baseURL: string): typeof globalThis.fetch {
    return async (input, init) => {
        const started = Date.now();
        const req = input instanceof Request ? input : new Request(input, init);
        let reqBody: unknown = null;
        let reqBytes = 0;
        try {
            const text = await req.clone().text();
            reqBytes = Buffer.byteLength(text, 'utf8');
            reqBody = text === '' ? null : (JSON.parse(text) as unknown);
        } catch {
            /* 读不出来不阻断：body 可能是 stream / 非 JSON */
        }

        const res = await fetchImpl(input, init);
        let resBody: unknown = null;
        let resBytes = 0;
        try {
            const text = await res.clone().text();
            resBytes = Buffer.byteLength(text, 'utf8');
            resBody = text.length > 8192 ? { truncated: true, head: text.slice(0, 8192) } : JSON.parse(text);
        } catch {
            /* 同上 */
        }

        try {
            port.push({
                kind: 'http',
                at: started,
                url: req.url,
                method: req.method,
                host: safeHostOf(req.url, baseURL),
                reqBytes,
                resBytes,
                reqBody,
                resBody,
                status: res.status,
                ms: Date.now() - started,
            });
        } catch {
            /* 见函数头：永不抛 */
        }
        return res;
    };
}

/** 从 URL 里取 host（`URL` 解析失败就退回配置的 baseURL，再失败给空串） */
function safeHostOf(url: string, baseURL: string): string {
    for (const candidate of [url, baseURL]) {
        try {
            return new URL(candidate).host;
        } catch {
            /* 换下一个 */
        }
    }
    return '';
}

const provider = createOpenAICompatible({
        name: config.name ?? 'diy-llm-provider',
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        includeUsage: true, // 流里带上 usage（不写这行，多数兼容上游不给流式用量）
        ...(Object.keys(fixed).length === 0 ? {} : { headers: fixed }),
        fetch:
            config.traffic === undefined
                ? (config.fetch ?? globalThis.fetch)
                : wrapFetchWithTraffic(config.fetch ?? globalThis.fetch, config.traffic, config.baseURL),
    });

    return {
        model: config.model,
        chat(messages: readonly ChatMessage[], options?: ChatOptions) {
            return chatStream(
                provider.chatModel(options?.model ?? config.model),
                messages,
                options,
                sessionHeaders(templated, options?.sessionId),
                { provider: config.name, model: options?.model ?? config.model, baseUrl: config.baseURL },
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

/**
 * 模型把工具调用写成原始标记（而不是结构化 part）时的特征。
 *
 * 用户 2026-11-04 指出：「老 app 没出现过，都是同样模型」—— 说明**根因不在模型**，
 * 而在我们传的参数不全（maxOutputTokens / reasoningEffort 缺失，见 chatStream 里的调用）。
 * 这里保留检测只作**防御**：真出现时给一句人话而不是把标签糊到界面上。
 */
const LEAKED_TOOL_XML = /<\|DSML\||<\/?(?:function_calls|invoke|parameter)[ >]/;

/**
 * 一次调用的流：text 增量 → usage → done；上游失败抛 `LlmProviderError`。
 *
 * **导出**是为了让「录制的事件流 → SessionDelta」能作为**黑盒**被测：
 * 传一个 `replay(fixture).asModel()` 进来，中间所有真实逻辑（DSML 泄漏改写、
 * 未知工具兜底、abort 分支、usage 归一）都会跑到。
 *
 * 为什么参数类型放宽成 `LanguageModel`：生产传的是 `provider.chatModel(...)`，
 * 测试传的是 `MockLanguageModelV3` —— 两者都满足 `streamText({ model })` 的约束。
 */
export async function* chatStream(
    model: LanguageModel,
    messages: readonly ChatMessage[],
    options: ChatOptions | undefined,
    headers: Record<string, string> | undefined,
    wire: WireIdentity,
): AsyncGenerator<SessionDelta> {
    let fullStream: AsyncIterable<{ type: string } & Record<string, unknown>>;
    const mapped = toModelMessages(messages);
    // ⚠️ thinking 模式下**每条** assistant 都必须带 reasoning_content（上游逐条校验，
    // 漏一条整轮 400）。不补就会被 ai-sdk 丢掉这个字段 —— 详见 reasoning-replay.ts。
    // 判据：reasoningEffort 存在且不是 "none" = thinking；deepseek 系才补（空串是否被接受
    // 只在这家有证据，别的 reasoning 模型补了可能反过来被判非法）。
    const effort = (options?.providerOptions as Record<string, Record<string, unknown>> | undefined)?.[
        'openaiCompatible'
    ]?.['reasoningEffort'];
    const thinking = typeof effort === 'string' && effort !== 'none' && effort !== '';
    const replayable = ensureReasoningReplay(mapped.messages, { thinking, deepseek: isDeepSeekWire(wire) });
    try {
        const result = streamText({
            model,
            // ai-sdk v7 不允许 `role: "system"` 出现在 messages 里：调用方给的 system 消息
            // 原样搬进 `system` 选项（只是换个位置，不增不改 —— 提示词仍归调用方）
            ...(mapped.system === undefined ? {} : { system: mapped.system }),
            messages: replayable,
            maxRetries: 0, // 重试不归 provider（见 errors.ts 头注）
            ...(headers === undefined ? {} : { headers }),
            ...(options?.signal === undefined ? {} : { abortSignal: options.signal }),
            // 工具循环交给 ai-sdk（##514 教训：自己写 runToolLoop = 重新发明 + 踩同样的坑）。
            // 与 diy-app 的做法一致：streamText({ tools, stopWhen: stepCountIs(n) })。
            ...(options?.tools === undefined ? {} : { tools: options.tools as never }),
            ...(options?.maxSteps === undefined ? {} : { stopWhen: stepCountIs(options.maxSteps) }),
            ...(options?.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
            ...(options?.providerOptions === undefined ? {} : { providerOptions: options.providerOptions as never }),
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
                    if (typeof text === 'string' && text.length > 0) {
                        // 模型把工具调用吐成原始 XML（实测 deepseek：`<|DSML| invoke name="Bash">`）。
                        // 原样透传会让用户看到一堆标签，且这轮什么也没执行 —— 换成一句人话。
                        if (LEAKED_TOOL_XML.test(text)) {
                            yield {
                                type: 'text',
                                text: '\n\n[工具调用格式错误] 模型把工具调用写成了原始标记而不是结构化调用，本轮没有执行任何操作。请重试。',
                            };
                            yield { type: 'done', stopReason: 'malformed-tool-call' };
                            return;
                        }
                        yield { type: 'text', text };
                    }
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
        // 模型调了不存在的工具（实测：deepseek 把 `bash` 写成 `Bash`）。
        //
        // ai-sdk 在**解析流时**就抛 `AI_NoSuchToolError`，根本走不到上层的工具查找，
        // 于是整轮对话变成「发出去了但什么都没回来」——用户看到的就是「没反应」。
        //
        // 这里不抛：转成一条**普通文本**再说一句「本轮作废」，让上层能把它显示出来。
        // 真正的修法是让模型别写错名，但模型错了不该让用户面对一个哑掉的界面。
        const unknownTool = unknownToolOf(cause);
        if (unknownTool !== undefined) {
            yield {
                type: 'text',
                text: `\n\n[工具名不存在] 模型调用了 \`${unknownTool}\`，可用的是小写工具名。本轮未执行任何操作，请重试或换个说法。`,
            };
            yield { type: 'done', stopReason: 'tool-not-found' };
            return;
        }
        throw classifyError(cause);
    }
}

/**
 * 从 `AI_NoSuchToolError` 里取出模型写的工具名。
 *
 * 判据是 `name === "AI_NoSuchToolError"` 而不是 `instanceof`：ai-sdk 在 CJS/ESM 双包下
 * 可能出现两份类定义，`instanceof` 会漏。名字是稳定的公开契约。
 */
function unknownToolOf(cause: unknown): string | undefined {
    const node = cause as { name?: unknown; toolName?: unknown } | undefined;
    if (node === undefined || node === null) return undefined;
    if (node.name !== 'AI_NoSuchToolError') return undefined;
    return typeof node.toolName === 'string' ? node.toolName : '(未知名)';
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
 * `ChatMessage` → ai-sdk 的 `ModelMessage`（##514 第 3 步：工具消息的**入向**映射）。
 *
 * 三条判据（漏任一条 → 模型看不到工具结果 → 重复调同一个工具）：
 *   ① `tool-call` 消息 ⇒ assistant 消息里的 `{ type:'tool-call', toolCallId, toolName, input }`
 *   ② `tool-result` 消息 ⇒ `{ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output }] }`
 *      （`toolCallId` 取自 `data.tool.id` —— 协议按它把结果挂回那次调用）
 *   ③ **连续的 assistant 消息合并成一条**：Session 把「先说话再调工具」拆成两条
 *      （agent-trace 正文 + tool-call），而协议要求它们属于**同一个 assistant 消息**——
 *      不合并就等于模型从没说过那段话。tool 消息同理按段合并。
 *
 * system 消息单独拆出来（v7 的 messages 不接受它，见 `system` 选项）。
 */
function toModelMessages(messages: readonly ChatMessage[]): {
    system?: string;
    messages: ModelMessage[];
} {
    const systems: string[] = [];
    const out: ModelMessage[] = [];
    let i = 0;
    while (i < messages.length) {
        const message = messages[i]!;
        const text = message.text ?? '';
        if (message.role === 'system') {
            if (text.length > 0) systems.push(text);
            i += 1;
            continue;
        }
        if (message.role === 'tool') {
            const parts: ToolResultPart[] = [];
            while (i < messages.length && messages[i]!.role === 'tool') {
                parts.push(toolResultPartOf(messages[i]!));
                i += 1;
            }
            out.push({ role: 'tool', content: parts });
            continue;
        }
        if (message.role === 'assistant') {
            const parts: AssistantContentParts = [];
            while (i < messages.length && messages[i]!.role === 'assistant') {
                parts.push(...assistantPartsOf(messages[i]!));
                i += 1;
            }
            if (parts.length > 0) out.push({ role: 'assistant', content: parts });
            continue;
        }
        if (text.length > 0) out.push({ role: 'user', content: text });
        i += 1;
    }
    return systems.length === 0 ? { messages: out } : { system: systems.join('\n\n'), messages: out };
}

/** 一条 assistant 消息 → content parts（正文与 tool-call **都要**，不能二选一） */
function assistantPartsOf(message: ChatMessage): AssistantContentParts {
    const tool = toolOf(message.data);
    if (message.type === 'tool-call' && tool !== null) {
        return [{ type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: tool.args }];
    }
    const text = message.text ?? '';
    return text.length === 0 ? [] : [{ type: 'text', text }];
}

/** 一条 tool 消息 → `ToolResultPart`；缺 tool_call_id 是宿主建消息时的错，当场说清（不猜） */
function toolResultPartOf(message: ChatMessage): ToolResultPart {
    const tool = toolOf(message.data);
    if (tool === null) {
        throw new TypeError(
            'tool-result 消息缺 `data.tool.id`（tool_call_id 是协议硬约束：没有它上游无法把结果挂回调用）',
        );
    }
    return {
        type: 'tool-result',
        toolCallId: tool.id,
        toolName: tool.name ?? '',
        output: { type: 'text', value: message.text ?? '' },
    };
}

/** `data.tool` 的宽松读取（Session 只保证「装得下」，不解释 schema） */
function toolOf(data: unknown): { id: string; name: string; args: unknown } | null {
    if (data === null || typeof data !== 'object') return null;
    const tool = (data as { tool?: unknown }).tool;
    if (tool === null || typeof tool !== 'object') return null;
    const record = tool as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id === '') return null;
    const name = record['name'];
    return {
        id,
        name: typeof name === 'string' ? name : '',
        args: record['args'],
    };
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
