// session.ts — 单会话状态机：消息列表 + 一次 LLM 调用 + 流式增量
//
// 一轮（turn）的完整语义：
//   ① 追加 user 消息（空正文报 `session/empty-text`）
//   ② 若有压缩策略，先跑一次（结果过 parseMessages —— 策略写坏了要炸在这里）
//   ③ 调 LlmPort 拿流：text 增量边收边吐、usage 记账、done 收尾
//   ④ 正文非空则追加 assistant 消息（**流式被取消也保留已收到的部分**：删掉它就等于
//      "agent 没说过"，而它确实说过半句）
//   ⑤ 落一次快照（store 缺省 = 不落盘）
//
// 并发：一个会话同一时刻只有一轮（`session/busy`）。取消 = abort 信号，适配器负责尽快收流。

import { SessionError } from './errors.js';
import { assertDelta, parseMessage, parseMessages } from './message.js';
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
    let usage = ZERO_USAGE;
    let busy = false;
    let controller: AbortController | null = null;
    const createdAt = iso(clock.now());
    let updatedAt = createdAt;

    const session: AgentSession = {
        id,
        get messages() {
            return messages.slice();
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
                appendMessage({ role: 'user', content: text });

                // ② 压缩（可选）：策略只改「这一轮看到的历史」，不替它判断对错
                let history = messages.slice();
                if (compact) {
                    history = parseMessages(await compact(history), 'compacted');
                    messages.length = 0;
                    messages.push(...history);
                    updatedAt = iso(clock.now());
                }

                // ③ 流式调用
                // 正文先攒在缓冲里：遇到 tool-call 就说明「这轮还没结束」，
                // 刚才那一段是 trace；本轮最后剩下的那段才是 agent-conclusion（##456 判据）。
                let buffer = '';
                let toolCalls = 0;
                let stopReason: string | undefined;
                let inputTokens = 0;
                let outputTokens = 0;
                const flushTrace = (): void => {
                    if (buffer === '') return;
                    appendMessage({ role: 'assistant', kind: 'agent-trace', content: buffer });
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
                                content: delta.input ?? '',
                                name: delta.name,
                                toolCallId: delta.id,
                            });
                            yield delta;
                        } else if (delta.type === 'tool-result') {
                            appendMessage({
                                role: 'tool',
                                kind: 'tool-result',
                                content: delta.content,
                                toolCallId: delta.id,
                            });
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
                    else appendMessage({ role: 'assistant', kind: 'agent-conclusion', content: buffer });
                }

                // ⑤ 记账 + 快照
                usage = {
                    inputTokens: usage.inputTokens + inputTokens,
                    outputTokens: usage.outputTokens + outputTokens,
                    turns: usage.turns + 1,
                };
                updatedAt = iso(clock.now());
                await persist();

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
    };

    if (options.system !== undefined) {
        session.append({ role: 'system', content: options.system });
    }

    function appendMessage(init: ChatMessageInit): ChatMessage {
        const message = parseMessage({ ...init, at: init.at ?? iso(clock.now()) }, `message(${messages.length})`);
        messages.push(message);
        updatedAt = message.at ?? updatedAt;
        return message;
    }

    async function persist(): Promise<void> {
        if (!store) return;
        await store.save(session.snapshot());
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
    if (typeof value !== 'object' || value === null || typeof value.save !== 'function') {
        throw new SessionError('session/invalid-options', 'store 必须是带 save() 的 SessionStore', 'store');
    }
    return value;
}
