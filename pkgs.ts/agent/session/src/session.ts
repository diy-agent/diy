// session.ts — 单会话状态机：消息列表 + 一次 LLM 调用 + 流式增量
//
// 一轮（turn）的完整语义：
//   ① 追加 user 消息（空正文报 `session/empty-text`）
//   ② 若有压缩策略，先跑一次（结果过 parseMessages —— 策略写坏了要炸在这里）
//   ③ 调 LlmPort 拿流：text 增量边收边吐、usage 记账、done 收尾
//      正文先攒缓冲：遇 tool-call 就把缓冲落成 agent-trace（这轮还没结束），
//      本轮最后剩下的那段才是 agent-conclusion（##456 判据）
//   ④ 记账 + 把新消息**追加**给 SessionStore（缺省 = 本包自带的内存 store，不落盘）
//
// seq：会话内全局单调（1 起），由本包分配；压缩只改「这一段历史」，不重置 seq
// （存储适配器/水位按 seq 对齐，跨桶连续的前提就在这一条）。
//
// 并发：一个会话同一时刻只有一轮（`session/busy`）。取消 = abort 信号，适配器负责尽快收流。

import { localISOString } from '@diy-agent/time';
import { SessionError } from './errors.js';
import type { ChatOptions, SessionRequest } from './types.js';
import { assertDelta, parseMessage, parseMessages, toolArgsFromInput } from './message.js';
import { openMemorySessionStore } from './store-memory.js';
import {
    systemClock,
    type AgentSession,
    type ChatMessage,
    type ChatMessageInit,
    type Clock,
    type Compactor,
    type LlmPort,
    type SessionDelta,
    type SessionSnapshot,
    type SessionStore,
    type TokenUsage,
    type ToolResultInput,
} from './types.js';

/** createSession 入参 */
export interface CreateSessionOptions {
    /** 会话 id（宿主命名；本包只当标识用） */
    id: string;
    /** LLM 端口（唯一外部能力依赖） */
    llm: LlmPort;
    /** 时钟端口；缺省取真时间 */
    clock?: Clock;
    /** 压缩策略（每轮调用前跑一次；缺省 = 不压缩） */
    compact?: Compactor;
    /**
     * 存储端口。**缺省 = 本包自带的内存 store**（`openMemorySessionStore()`，不落盘）。
     * 要持久化由装配器实例化后传进来（如 `openJsonlSessionStore({ dir })`）—— 本包不分派策略。
     */
    store?: SessionStore;
    /** 原样传给 LlmPort 的模型标识 */
    model?: string;
    /** 初始 system 消息（可选） */
    system?: string;
    /**
     * 恢复历史（宿主从 store.readFrom(0) 拿到后传进来）。
     * 每条必须带 seq；本包据此续上 lastSeq，不会重号。
     */
    initialMessages?: readonly ChatMessage[];
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };

/**
 * 建一个会话。返回的对象是活视图（`messages` / `usage` 每次读都是最新），
 * 但对外暴露的数组是**只读**的副本——外部改不动历史。
 */
export function createSession(options: CreateSessionOptions): AgentSession {
    const id = takeId(options.id);
    const llm = takeLlm(options.llm);
    const clock = takeClock(options.clock);
    const compact = takeCompactor(options.compact);
    const store = takeStore(options.store ?? openMemorySessionStore());
    /** store 是否本包自建（缺省内存实现）：自建的是空的，恢复历史要自己灌进去；外部 store 已经装着 */
    const ownsStore = options.store === undefined;
    const model = options.model;

    const messages: ChatMessage[] = [];
    let lastSeq = 0;
    for (const message of parseMessages(options.initialMessages ?? [], 'initialMessages')) {
        if (message.seq === undefined) {
            throw new SessionError('session/invalid-message', '恢复历史的消息必须带 seq', 'initialMessages');
        }
        if (message.seq <= lastSeq) {
            throw new SessionError(
                'session/invalid-message',
                `seq 必须严格递增（${message.seq} 在 ${lastSeq} 之后）`,
                'initialMessages',
            );
        }
        lastSeq = message.seq;
        messages.push(message);
    }

    // 自建 store 是空的：把恢复历史先灌进去，否则接下来的 append 会从 seq=1 断号
    // （内存 store 允许首批从中途 seq 开始，所以截断过的历史也装得下）
    if (ownsStore && messages.length > 0) store.append(messages.slice());

    let usage = ZERO_USAGE;
    let busy = false;
    let controller: AbortController | null = null;
    /** 上一次真发的请求快照（见 types.ts 的 `AgentSession.lastRequest`） */
    let lastRequestSnapshot: SessionRequest | null = null;
    const createdAt = iso(clock.now());
    let updatedAt = createdAt;
    /** store 的写链：append 排队、串行落盘（宿主不需要自己排序） */
    let writes: Promise<void> = Promise.resolve();
    /** 还没写完的消息（send 结束 / flush() 时统一 await） */
    let pendingWrites = 0;
    /** 落盘错误：不丢，在 flush() / send 收尾处抛出来 */
    let writeError: unknown;

    const session: AgentSession = {
        id,
        get messages() {
            return messages.slice();
        },
        get lastRequest() {
            return lastRequestSnapshot;
        },
        get lastSeq() {
            return lastSeq;
        },
        get usage() {
            return usage;
        },
        get busy() {
            return busy;
        },
        get createdAt() {
            return createdAt;
        },
        get updatedAt() {
            return updatedAt;
        },
        append(init: ChatMessageInit) {
            return appendMessage(init);
        },
        async *send(text: string, turnOptions?: ChatOptions): AsyncGenerator<SessionDelta> {
            if (typeof text !== 'string' || text.trim() === '') {
                throw new SessionError('session/empty-text', 'send() 的正文不能为空', 'text');
            }
            // 跨轮上下文补丁合进本轮 user 正文（不单独发一条，见 ChatOptions.userPrefix）
            const body =
                turnOptions?.userPrefix === undefined || turnOptions.userPrefix === ''
                    ? text
                    : `${turnOptions.userPrefix}\n${text}`;
            yield* runTurn(() => {
                appendMessage({ role: 'user', text: body });
            }, turnOptions);
        },
        /**
         * 拿「刚执行完的工具结果」继续这一轮（##514 第 3 步）。
         *
         * **这是给宿主做工具循环用的，不是 send 的替代**：
         *   · send      —— 一轮对话的开始（追加 user 消息）
         *   · 本方法    —— 同一轮里的下一步（追加 tool 结果消息，**不再追加 user**）
         * 为什么不能拿 send 顶：工具结果在协议里必须是 `role:'tool'` 且按 tool_call_id 配对
         * （OpenAI 兼容协议硬约束），混成 user 正文上游会拒或让模型重复调工具。
         *
         * 记账语义与 send 完全一致（压缩 → 调 LLM → usage 累加 → 落盘 → done），
         * 因为它们共用同一个 `runTurn()`。
         */
        async *continueWithToolResults(results: readonly ToolResultInput[]): AsyncGenerator<SessionDelta> {
            const list = takeToolResults(results);
            yield* runTurn(() => {
                const last = messages.at(-1);
                if (last === undefined || last.type !== 'tool-call') {
                    throw new SessionError(
                        'session/nothing-to-continue',
                        'continueWithToolResults 要求上一条消息是 tool-call（没有待回收的调用）',
                        'messages',
                    );
                }
                for (const result of list) appendToolResult(result);
            });
        },
        cancel() {
            controller?.abort();
        },
        snapshot(): SessionSnapshot {
            return { id, messages: messages.slice(), usage, createdAt, updatedAt };
        },
        flush,
    };

    /**
     * 一轮 LLM 调用 —— send 与 continueWithToolResults 共用的**唯一**实现（##514 第 3 步）。
     *
     * `prepare()` 只负责「这一轮开始前要落的历史」：
     *   · send                      ⇒ 追加 user 消息
     *   · continueWithToolResults   ⇒ 追加 tool 结果消息（不追加 user）
     * 其余（压缩 / 流式 / usage 累加 / 落盘 / done）逐字相同 —— 复制一份必然分叉。
     */
    async function* runTurn(prepare: () => void, turnOptions?: ChatOptions): AsyncGenerator<SessionDelta> {
        if (busy) {
            throw new SessionError('session/busy', `会话 ${id} 上一轮还没结束（先 await 完，或 cancel()）`, 'busy');
        }
        busy = true;
        controller = new AbortController();
        const signal = controller.signal;
        try {
            // ① 这一轮开始前要落的历史（send ⇒ user 消息；工具循环 ⇒ tool 结果）
            prepare();

            // ② 压缩（可选）：策略只改「这一轮看到的历史」，不替它判断对错
            let history = messages.slice();
            if (compact) {
                history = parseMessages(await compact(history), 'compacted');
                messages.length = 0;
                messages.push(...history);
                updatedAt = iso(clock.now());
            }

            // ③ 流式调用
            let buffer = '';
            let toolCalls = 0;
            /** 本轮落过几条工具结果（判「剩下的是不是结论」：两者都算「这轮在干活」） */
            let toolResults = 0;
            let stopReason: string | undefined;
            let inputTokens = 0;
            let outputTokens = 0;
            let cacheReadTokens = 0;
            const flushTrace = (): void => {
                if (buffer === '') return;
                appendMessage({ role: 'assistant', type: 'agent-trace', text: buffer });
                buffer = '';
            };
            try {
                // sessionId 由会话自动带上（provider 拿它填上游路由 / 缓存 header，调用方不用管）
                // 记下**这一轮真发的**快照（压缩 / 增量注入之后、发送之前）—— 见 types.ts 的说明
                lastRequestSnapshot = { messages: history.slice() };
                for await (const raw of llm.chat(history.slice(), {
                    ...turnOptions,
                    model,
                    signal,
                    sessionId: id,
                })) {
                    const delta = assertDelta(raw);
                    if (signal.aborted) break;
                    if (delta.type === 'text') {
                        buffer += delta.text;
                        yield delta;
                    } else if (delta.type === 'tool-call') {
                        flushTrace();
                        toolCalls += 1;
                        appendMessage({
                            role: 'assistant',
                            type: 'tool-call',
                            // 分支私有载荷进 data（判别键同级只放公共字段）
                            data: { tool: { name: delta.name, args: toolArgsFromInput(delta.input), id: delta.id } },
                        });
                        yield delta;
                    } else if (delta.type === 'tool-result') {
                        // 宿主/provider 自己回收的结果也按同一形状落（带 tool_call_id，供投递侧配对）
                        appendMessage({
                            role: 'tool',
                            type: 'tool-result',
                            text: delta.content,
                            data: { tool: { id: delta.id } },
                        });
                        toolResults += 1;
                        yield delta;
                    } else if (delta.type === 'usage') {
                        inputTokens += delta.inputTokens;
                        outputTokens += delta.outputTokens;
                        cacheReadTokens += delta.cacheReadTokens ?? 0;
                    } else {
                        stopReason = delta.stopReason;
                    }
                }
            } catch (error) {
                // 主动取消不算失败：保留已收到的正文，收尾成 done
                if (!signal.aborted) throw error;
                stopReason = stopReason ?? 'aborted';
            }
            const aborted = signal.aborted;
            if (aborted && stopReason === undefined) stopReason = 'aborted';

            // ④ 收尾：正常结束剩下的是结论；被取消且中间调过工具 ⇒ 只能算 trace
            //   `toolResults` 也计入「中间干过活」：最后一步是「拿到结果但不说话」时，
            //   这段正文仍属过程（工具循环一轮 = 多次 runTurn，结论只看最后一个 runTurn）。
            if (buffer !== '') {
                if (aborted && (toolCalls > 0 || toolResults > 0)) flushTrace();
                else appendMessage({ role: 'assistant', type: 'agent-conclusion', text: buffer });
            }

            // ⑤ 记账 + 落盘
            // 缓存读桶：上游一步都没报就**字段缺席**（不补 0 —— 「没报」与「命中 0」不是一回事）
            const cacheTotal = (usage.cacheReadTokens ?? 0) + cacheReadTokens;
            usage = {
                inputTokens: usage.inputTokens + inputTokens,
                outputTokens: usage.outputTokens + outputTokens,
                turns: usage.turns + 1,
                ...(cacheTotal > 0 ? { cacheReadTokens: cacheTotal } : {}),
            };
            updatedAt = iso(clock.now());
            await flush();

            yield stopReason === undefined ? { type: 'done' } : { type: 'done', stopReason };
        } finally {
            busy = false;
            controller = null;
        }
    }


    if (options.system !== undefined) {
        session.append({ role: 'system', text: options.system });
    }

    /**
     * 工具结果 → 一条 `role:'tool'` 消息（**按 tool_call_id 配对**）。
     *
     * 为什么 id 落进 `data.tool.id` 而不是单独字段：消息形状是判别联合，分支私有载荷一律进 `data`
     * （`tool-call` 已这么放）—— 投递侧（provider）靠它拼 `{ role:'tool', tool_call_id }`。
     */
    function appendToolResult(result: ToolResultInput): ChatMessage {
        return appendMessage({
            role: 'tool',
            type: 'tool-result',
            text: typeof result.content === 'string' ? result.content : jsonTextOf(result.content),
            data: { tool: { id: result.id, ...(result.name === undefined ? {} : { name: result.name }) } },
        });
    }

    /** store 恒存在（缺省内存实现）：append 一律排队写，flush 统一收口错误。 */
    function appendMessage(init: ChatMessageInit): ChatMessage {
        lastSeq += 1;
        const message = parseMessage(
            { ...init, seq: lastSeq, at: init.at ?? clock.now() },
            `message(${messages.length})`,
        );
        messages.push(message);
        updatedAt = iso(clock.now());
        pendingWrites += 1;
        writes = writes.then(async () => {
            try {
                await store.append([message]);
            } catch (error) {
                writeError ??= error;
            } finally {
                pendingWrites -= 1;
            }
        });
        return message;
    }

    async function flush(): Promise<void> {
        if (pendingWrites === 0) return;
        await writes;
        if (writeError !== undefined) throw writeError;
    }

    return session;
}

function iso(ms: number): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new SessionError('session/invalid-options', `Clock.now() 必须返回有限数字，拿到 ${String(ms)}`, 'clock');
    }
    return localISOString(new Date(ms));
}

function takeId(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new SessionError('session/invalid-options', 'id 必须是非空字符串', 'id');
    }
    return value;
}

function takeLlm(value: unknown): LlmPort {
    if (typeof value !== 'object' || value === null || typeof (value as LlmPort).chat !== 'function') {
        throw new SessionError('session/invalid-options', 'llm 必须是带 chat() 的 LlmPort', 'llm');
    }
    return value as LlmPort;
}

function takeClock(value: Clock | undefined): Clock {
    if (value === undefined) return systemClock;
    if (typeof value !== 'object' || value === null || typeof value.now !== 'function') {
        throw new SessionError('session/invalid-options', 'clock 必须是带 now() 的对象', 'clock');
    }
    return value;
}

function takeCompactor(value: Compactor | undefined): Compactor | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'function') {
        throw new SessionError('session/invalid-options', 'compact 必须是函数', 'compact');
    }
    return value;
}

/** 任意值 → JSON 文本（`undefined` / 不可序列化 → `"null"`，不抛） */
function jsonTextOf(value: unknown): string {
    if (value === undefined) return 'null';
    try {
        const text = JSON.stringify(value);
        return typeof text === 'string' ? text : 'null';
    } catch {
        return 'null';
    }
}

/**
 * 校验 `continueWithToolResults` 的入参（**不静默容错**，同本包其余入口）。
 * 空数组同样是错：一次都不执行的「继续」等于让模型重复调一次工具（死循环的入口）。
 */
function takeToolResults(value: unknown): readonly ToolResultInput[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new SessionError(
            'session/invalid-tool-results',
            'continueWithToolResults 需要至少一条工具结果',
            'results',
        );
    }
    return value.map((item, index) => {
        const path = `results[${index}]`;
        if (typeof item !== 'object' || item === null) {
            throw new SessionError('session/invalid-tool-results', `${path} 必须是对象`, path);
        }
        const record = item as Record<string, unknown>;
        const id = record['id'];
        if (typeof id !== 'string' || id === '') {
            throw new SessionError('session/invalid-tool-results', `${path}.id 必须是非空字符串`, `${path}.id`);
        }
        const name = record['name'];
        if (name !== undefined && typeof name !== 'string') {
            throw new SessionError('session/invalid-tool-results', `${path}.name 必须是字符串`, `${path}.name`);
        }
        return name === undefined ? { id, content: record['content'] } : { id, name, content: record['content'] };
    });
}

function takeStore(value: unknown): SessionStore {
    if (value === undefined) return openMemorySessionStore();
    if (typeof value !== 'object' || value === null) {
        throw new SessionError('session/invalid-options', 'store 必须是对象', 'store');
    }
    const store = value as SessionStore;
    if (
        typeof store.append !== 'function' ||
        typeof store.readFrom !== 'function' ||
        typeof store.latestSeq !== 'function'
    ) {
        throw new SessionError(
            'session/invalid-options',
            'store 必须是带 append() / readFrom() / latestSeq() 的 SessionStore',
            'store',
        );
    }
    return store;
}
