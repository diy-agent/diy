// session.ts — 单会话状态机：消息列表 + 一次 LLM 调用 + 流式增量
//
// 一轮（turn）的完整语义：
//   ① 追加 user 消息（空正文报 `session/empty-text`）
//   ② 若有压缩策略，先跑一次（结果过 parseMessages —— 策略写坏了要炸在这里）
//   ③ 调 LlmPort 拿流：text 增量边收边吐、usage 记账、done 收尾
//      正文先攒缓冲：遇 tool-call 就把缓冲落成 agent-trace（这轮还没结束），
//      本轮最后剩下的那段才是 agent-conclusion（##456 判据）
//   ④ 记账 + 把新消息**追加**给 SessionStore（缺省不落盘）
//
// seq：会话内全局单调（1 起），由本包分配；压缩只改「这一段历史」，不重置 seq
// （存储适配器/水位按 seq 对齐，跨桶连续的前提就在这一条）。
//
// 并发：一个会话同一时刻只有一轮（`session/busy`）。取消 = abort 信号，适配器负责尽快收流。

import { SessionError } from './errors.js';
import { assertDelta, parseMessage, parseMessages, toolArgsFromInput } from './message.js';
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
    /** 存储端口（缺省 = 纯内存，不落盘） */
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
    const store = takeStore(options.store);
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

    let usage = ZERO_USAGE;
    let busy = false;
    let controller: AbortController | null = null;
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
        async *send(text: string): AsyncGenerator<SessionDelta> {
            if (typeof text !== 'string' || text.trim() === '') {
                throw new SessionError('session/empty-text', 'send() 的正文不能为空', 'text');
            }
            if (busy) {
                throw new SessionError('session/busy', `会话 ${id} 上一轮还没结束（先 await 完，或 cancel()）`, 'busy');
            }
            busy = true;
            controller = new AbortController();
            const signal = controller.signal;
            try {
                appendMessage({ role: 'user', text });

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
                let stopReason: string | undefined;
                let inputTokens = 0;
                let outputTokens = 0;
                const flushTrace = (): void => {
                    if (buffer === '') return;
                    appendMessage({ role: 'assistant', kind: 'agent-trace', text: buffer });
                    buffer = '';
                };
                try {
                    for await (const raw of llm.chat(history.slice(), { model, signal })) {
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
                                kind: 'tool-call',
                                tool: { name: delta.name, args: toolArgsFromInput(delta.input), id: delta.id },
                            });
                            yield delta;
                        } else if (delta.type === 'tool-result') {
                            appendMessage({ role: 'tool', kind: 'tool-result', text: delta.content });
                            yield delta;
                        } else if (delta.type === 'usage') {
                            inputTokens += delta.inputTokens;
                            outputTokens += delta.outputTokens;
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
                if (buffer !== '') {
                    if (aborted && toolCalls > 0) flushTrace();
                    else appendMessage({ role: 'assistant', kind: 'agent-conclusion', text: buffer });
                }

                // ⑤ 记账 + 落盘
                usage = {
                    inputTokens: usage.inputTokens + inputTokens,
                    outputTokens: usage.outputTokens + outputTokens,
                    turns: usage.turns + 1,
                };
                updatedAt = iso(clock.now());
                await flush();

                yield stopReason === undefined ? { type: 'done' } : { type: 'done', stopReason };
            } finally {
                busy = false;
                controller = null;
            }
        },
        cancel() {
            controller?.abort();
        },
        snapshot(): SessionSnapshot {
            return { id, messages: messages.slice(), usage, createdAt, updatedAt };
        },
        flush,
    };

    if (options.system !== undefined) {
        session.append({ role: 'system', text: options.system });
    }

    function appendMessage(init: ChatMessageInit): ChatMessage {
        lastSeq += 1;
        const message = parseMessage(
            { ...init, seq: lastSeq, at: init.at ?? clock.now() },
            `message(${messages.length})`,
        );
        messages.push(message);
        updatedAt = iso(clock.now());
        if (store) {
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
        }
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
    return new Date(ms).toISOString();
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

function takeStore(value: SessionStore | undefined): SessionStore | undefined {
    if (value === undefined) return undefined;
    if (
        typeof value !== 'object' ||
        value === null ||
        typeof value.append !== 'function' ||
        typeof value.readFrom !== 'function' ||
        typeof value.latestSeq !== 'function'
    ) {
        throw new SessionError(
            'session/invalid-options',
            'store 必须是带 append() / readFrom() / latestSeq() 的 SessionStore',
            'store',
        );
    }
    return value;
}
