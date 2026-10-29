// types.ts — @diy/agent-session 的公开契约（纯类型 + 一个缺省 Clock）
//
// 边界（##456「关键设计决策 ②」）：
//   属于 Session：消息列表 / 一次 LLM 调用 + 流式增量 / 单会话压缩（注入策略）/ token 计量
//   不属于 Session：多成员投递（@diy/room）/ 任务状态 / 文件系统（store 适配器）
//
// 因此本文件里没有任何文件系统 / 应用数据根 / 任务概念——IO 一律由调用方注入。

/** 一条消息的角色（给 LLM 看的形状）。`tool` 留给工具结果 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 消息的**语义分类**（##456「数据分层修订」，5 种）：
 *   human              —— 人说的
 *   agent-conclusion   —— 一轮结束时的自然语言答复（进 Room 主线的那个）
 *   agent-trace        —— 中间步骤 / 过渡语（只在二级日志里）
 *   tool-call          —— 工具调用
 *   tool-result        —— 工具结果
 *
 * 只有 human + agent-conclusion 会进 @diy/room 的主线（`publicLog`），其余只在会话日志里。
 * 判据：有 tool-call ⇒ 这一轮还没结束，之前的文字是 trace；本轮最后一段文字才是 conclusion。
 */
export type MessageKind = 'human' | 'agent-conclusion' | 'agent-trace' | 'tool-call' | 'tool-result';

/** 会话里的一条消息（不可变；`at` 由 session 用 Clock 补齐） */
export interface ChatMessage {
    readonly role: MessageRole;
    /**
     * 语义分类。缺省按 role 推导（user→human / assistant→agent-conclusion / tool→tool-result）；
     * `system` 消息没有分类（它不是对话内容）。
     */
    readonly kind?: MessageKind;
    readonly content: string;
    /** ISO-8601，写入时刻；调用方不传则由 session 补 */
    readonly at?: string;
    /** 可选署名（多人物 / 多 agent 场景里区分同一个 role） */
    readonly name?: string;
    /** role=tool 时指回哪个 tool call（宿主约定） */
    readonly toolCallId?: string;
}

/** append / send 的入参：`at` 可省（session 补） */
export interface ChatMessageInit {
    role: MessageRole;
    kind?: MessageKind;
    content: string;
    at?: string;
    name?: string;
    toolCallId?: string;
}

/**
 * LlmPort 的流式增量（判别联合，判别键 `type`）：
 *   text        —— 正文增量（可多次）
 *   tool-call   —— 模型要调工具（这一轮还没结束）
 *   tool-result —— 工具结果（宿主执行后喂回来；本包不执行工具）
 *   usage       —— 本次调用的 token 用量（可有可无；缺省 = 不计量，不补 0）
 *   done        —— 结束（`stopReason` 由适配器翻译成自己的词表，本包不解释）
 */
export type SessionDelta =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly input?: string }
    | { readonly type: 'tool-result'; readonly id: string; readonly content: string }
    | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
    | { readonly type: 'done'; readonly stopReason?: string };

/** 一次 LLM 调用的选项（本包不解释具体含义，原样交给适配器） */
export interface ChatOptions {
    readonly model?: string;
    readonly signal?: AbortSignal;
}

/**
 * LLM 端口 —— 本包**唯一**的外部能力依赖。
 * 适配器把自己那家 SDK 的流式响应翻译成 `SessionDelta`；本包不 import 任何 SDK。
 */
export interface LlmPort {
    chat(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<SessionDelta>;
}

/** 时钟端口：只取毫秒时间戳（测试注入假 Clock，不碰真时间） */
export interface Clock {
    now(): number;
}

/** 缺省时钟（真时间；测试里显式注入假时钟即可获得确定性） */
export const systemClock: Clock = { now: () => Date.now() };

/** token 计量（一轮一次；`turns` = 已完成的轮数） */
export interface TokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly turns: number;
}

/**
 * 压缩策略（可选注入）：每轮调用 LLM **之前**跑一次，决定这一轮看到什么历史。
 * 策略怎么算（保留边界 / 摘要 / 窗口）不归本包——本包只负责在正确时机调用并校验结果。
 */
export type Compactor = (messages: readonly ChatMessage[]) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>;

/** 会话快照（store 适配器拿到的东西；不含任何活对象） */
export interface SessionSnapshot {
    readonly id: string;
    readonly messages: readonly ChatMessage[];
    readonly usage: TokenUsage;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * 存储端口（可选）。缺省 = 纯内存，一个字节也不落盘。
 * 落盘形态（jsonl / sqlite / 远端）由适配器决定，本包不碰文件系统。
 */
export interface SessionStore {
    save(snapshot: SessionSnapshot): void | Promise<void>;
}

/**
 * 「能发话的最小会话」—— @diy/room 只依赖这个形状，不依赖 AgentSession 的全部方法。
 * 这样 room 的测试可以注入极简假会话，宿主也能把别家实现接进来。
 */
export interface SessionPeer {
    readonly id: string;
    readonly busy: boolean;
    send(text: string): AsyncIterable<SessionDelta>;
}

/**
 * 会话活视图（由 `createSession()` 产出）。
 * `messages` / `usage` 每次读都是最新；数组是副本 —— 外部改不动历史。
 */
export interface AgentSession extends SessionPeer {
    readonly messages: readonly ChatMessage[];
    readonly usage: TokenUsage;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** 追加一条消息（不触发 LLM；at 缺省用 Clock 补） */
    append(message: ChatMessageInit): ChatMessage;
    /** 跑一轮：追加 user → （压缩）→ 调 LLM → 增量流 → 收尾 */
    send(text: string): AsyncIterable<SessionDelta>;
    /** 取消正在跑的一轮（abort 信号；已收到的正文保留） */
    cancel(): void;
    /** 当前快照（交给 SessionStore / 宿主） */
    snapshot(): SessionSnapshot;
}
