// types.ts — @diy-agent/session 的公开契约（纯类型 + 一个缺省 Clock）
//
// 边界（##456「关键设计决策 ②」）：
//   属于 Session：消息列表 / 一次 LLM 调用 + 流式增量 / 单会话压缩（注入策略）/ token 计量
//   不属于 Session：多成员投递（@diy-agent/room）/ 任务状态 / 文件系统（store 适配器）
//
// 因此本文件里没有任何文件系统 / 应用数据根 / 任务概念——IO 一律由调用方注入。

/** 一条消息的角色（给 LLM 看的形状）。`tool` 留给工具结果 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 消息的**语义分类**（判别键 `type`，设计定稿 `session-design.md` §二，6 种）：
 *   human              —— 人说的
 *   agent-conclusion   —— 一轮结束时的自然语言答复（进 Room 主线的那个）
 *   agent-notice       —— agent 主动播报（room_say 类工具）
 *   agent-trace        —— 中间步骤 / 过渡语（只在二级日志里）
 *   tool-call          —— 工具调用
 *   tool-result        —— 工具结果
 *
 * 只有 human + agent-conclusion + agent-notice 会进 @diy-agent/room 的主线（`publicLog`），
 * 其余（trace / tool）只在会话日志里。
 * 判据：有 tool-call ⇒ 这一轮还没结束，之前的文字是 trace；本轮最后一段文字才是 conclusion。
 *
 * 判别键按 diy 规范（`knowledge/facts/rule.yaml` rule.code#discriminated-union）用 `type`：
 * 与 `type` 同级的字段 = 所有分支共有；分支私有的载荷一律进 `data`。
 */
export type MessageType = 'human' | 'agent-conclusion' | 'agent-notice' | 'agent-trace' | 'tool-call' | 'tool-result';

/**
 * 工具调用 —— **tool-call 消息的私有载荷**，落在 `message.data.tool`（`{ type: 'tool-call', data: { tool } }`）。
 * Session 产出它时按这个形状写；`data` 其余内容本包不解释。
 */
export interface ChatToolCall {
    readonly name: string;
    /** 参数（宿主原样给的 JSON 值） */
    readonly args: unknown;
    readonly id: string;
}

/** 会话里的一条消息（不可变；`at` 由 session 用 Clock 补齐） */
export interface ChatMessage {
    /**
     * 会话内全局单调递增序号（1 起，跨压缩/跨桶连续）；由 session 分配。
     * 存储适配器与水位（Room 的 lastSeenSeq）都按它对齐。
     */
    readonly seq?: number;
    readonly role: MessageRole;
    /**
     * 语义分类（判别键）。缺省按 role 推导（user→human / assistant→agent-conclusion / tool→tool-result）；
     * `system` 消息没有分类（它不是对话内容）。
     */
    readonly type?: MessageType;
    /** 正文（tool-call 消息没有正文） */
    readonly text?: string;
    /** 提到了谁（Room 用；Session 原样保存，不解释） */
    readonly mentions?: readonly string[];
    /** 写入时刻（毫秒）；调用方不传则由 session 用 Clock 补 */
    readonly at?: number;
    /**
     * **结构化能力槽位**：分支私有载荷都放这里（如 `tool-call` ⇒ `{ tool }`）。
     *
     * Session 只保证「装得下、原样吐出」：写入时校验它可 JSON 序列化（能落盘、能跨进程），
     * **不解释里面的 schema** —— 怎么理解 / 渲染是上层策略（UI、Room、压缩策略各自决定）。
     * 嵌套同构：`data` 里的子对象也可以再是 `{ type, data }`，本包递归不管。
     */
    readonly data?: unknown;
}

/** append / send 的入参：`at` 可省（session 补） */
export interface ChatMessageInit {
    role: MessageRole;
    type?: MessageType;
    text?: string;
    mentions?: readonly string[];
    at?: number;
    /** 同 `ChatMessage.data`：分支私有载荷，Session 原样保存 */
    data?: unknown;
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
    | {
          readonly type: 'usage';
          readonly inputTokens: number;
          readonly outputTokens: number;
          /** 缓存读（命中）；缺省 = 上游没报。`inputTokens` 已含它，本包不重复累计 */
          readonly cacheReadTokens?: number;
          /** 缓存写；缺省 = 上游没报 */
          readonly cacheWriteTokens?: number;
      }
    | { readonly type: 'done'; readonly stopReason?: string };

/** 一次 LLM 调用的选项（本包不解释具体含义，原样交给适配器） */
export interface ChatOptions {
    readonly model?: string;
    readonly signal?: AbortSignal;
    /** 会话标识：由 Session 自动传入，调用方不用管。provider 用它填上游路由 / 缓存 header。 */
    readonly sessionId?: string;
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
 *
 * 四个方法就是**追加日志**的全部语义（设计定稿 `session-design.md` §三）：
 *   append(messages)      —— 只追加；每条必须带 seq（适配器按 seq 排序 / 分桶）
 *   readFrom(seq)         —— 读 `seq > X` 的那些（按桶的 toSeq 定位，不扫全量）
 *   readRange({from,to})  —— 读 at 在 [from, to] 的那些（按桶的 fromAt/toAt 二分，不扫全量）
 *   latestSeq()           —— 已落盘的最大 seq（新会话从 0 开始）
 *
 * 落盘形态（分桶 jsonl / sqlite / 远端）由适配器决定，本包不碰文件系统。
 */
export interface SessionStore {
    append(messages: readonly ChatMessage[]): void | Promise<void>;
    readFrom(seq: number): readonly ChatMessage[] | Promise<readonly ChatMessage[]>;
    /** 按时间读（毫秒，闭区间） */
    readRange(range: {
        readonly from: number;
        readonly to: number;
    }): readonly ChatMessage[] | Promise<readonly ChatMessage[]>;
    latestSeq(): number | Promise<number>;
}

/**
 * 「能发话的最小会话」—— @diy-agent/room 只依赖这个形状，不依赖 AgentSession 的全部方法。
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
    /** 已分配的最大 seq（没消息 = 0） */
    readonly lastSeq: number;
    readonly usage: TokenUsage;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** 追加一条消息（不触发 LLM；at 缺省用 Clock 补） */
    append(message: ChatMessageInit): ChatMessage;
    /** 跑一轮：追加 user → （压缩）→ 调 LLM → 增量流 → 收尾 */
    send(text: string): AsyncIterable<SessionDelta>;
    /** 取消正在跑的一轮（abort 信号；已收到的正文保留） */
    cancel(): void;
    /** 当前快照（给宿主做展示 / 调试；落盘走 SessionStore.append） */
    snapshot(): SessionSnapshot;
    /** 等 store 把已追加的消息写完（append 在 send 外调用时用） */
    flush(): Promise<void>;
}
