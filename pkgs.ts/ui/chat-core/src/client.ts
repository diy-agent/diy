// client.ts —— ChatClient 契约（纯接口）。
//
// 这一层不认识 HTTP / SSE / WebSocket / ipc：传输实现放在独立的 transport 包里。
//   现在：@diy-agent/chat-transport-rpc
//   将来：@diy-agent/chat-transport-rpc（diy-rpc 落地后直接换实现，core 不动）

import type { AskAnswer, Command, Snapshot, StreamEvent } from './types';

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

/** 一次压缩的事件（够 UI 展示即可，字段以后端为准） */
export interface CompactEventInfo {
    at: number;
    strategy: string;
    turn: number;
    durationMs: number;
    before: { entries: number; chars: number };
    after: { entries: number; chars: number };
    folded: number;
    dropped: number;
    /** 本次是否新生成摘要（沿用旧摘要 / 失败都是 false） */
    summarized: boolean;
    /** 最终落进压缩说明的摘要正文（新生成的，或沿用的旧摘要） */
    summary?: string;
    /** 摘要失败原因；undefined = 成功或没试。压缩本身仍算成功 */
    summaryError?: string;
}

export interface SessionStats {
    /** 当前上下文条数（含尚未并入的公共条目） */
    entries: number;
    /** 估算字符数（≈ token × 1.3） */
    chars: number;
    /** 当前生效的默认预算（自动压缩用它） */
    budget: { keepLast: number; maxChars: number };
    /** 历史累计丢弃条数 */
    collapsed: number;
    compactions: number;
    lastCompactAt?: number;
    /** 正在用的压缩策略名 */
    strategy: string;
    /** 当前上下文首条说明里带着的摘要正文；没有 = 未摘要 */
    summary?: string;
    /** 上一轮实测用量 */
    usage?: TokenUsage;
}

/** 一个 bot 在这个 room 里的会话概况 */
export interface SessionInfo {
    botId: string;
    name: string;
    stats: SessionStats;
    compactions: CompactEventInfo[];
}

export interface CompactOutcome {
    /** 这次压缩的 id（也出现在 `compact` 事件里）；拿它取消 / 去重 */
    compactId?: string;
    /** 受理即返：这次不返回结果，进展看 `compact` 事件；老服务端仍会给 */
    event?: CompactEventInfo | null;
    stats?: SessionStats;
}

export interface ChatClient {
    /** 拉历史快照（首屏 / 重载 / 重放） */
    load(entityId: string): Promise<Snapshot>;

    /**
     * 提交命令；事件通过 onEvent 回推。signal 取消只影响本地这次请求（不影响服务端的运行）。
     *
     * 语义是**受理即返**：返回不等于「这一轮说完了」，事件继续从 `watch()` 那条订阅进来。
     * 别把它实现成「一条挂到整轮结束的 SSE」—— 多页工作台下那样会吃满同源连接上限。
     */
    post(
        entityId: string,
        command: Command,
        onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
    ): Promise<void>;

    /** 可选：上下文观测（后端支持才有） */
    sessions?(entityId: string): Promise<SessionInfo[]>;

    /** 可选：手动压缩某个 bot 的上下文（只影响它自己，不触发运行） */
    compact?(
        entityId: string,
        botId: string,
        options?: { keepLast?: number; maxChars?: number },
    ): Promise<CompactOutcome>;

    /**
     * 可选：撤掉一次正在跑的压缩。
     *
     * 返回 false = 已经跑完 / 不认识这个 id —— 不抛错：手点慢一点不该弹错误条。
     */
    cancelCompact?(entityId: string, compactId: string): Promise<boolean>;

    /**
     * 可选：常驻订阅这个房间的事件（后台 bot 的回复、提问、投递状态都能实时看到）。
     * 返回取消订阅。
     *
     * **不要**为每个房间各开一条连接：多上下文（多页 / 多标签页）下会把浏览器同源
     * 6 条的上限吃满，连 `/history` 都永久排队。HTTP 实现是把房间当成一条共用连接上的
     * 话题；换成 rpc 时同样应该是一条连接 + 订阅。
     */
    watch?(entityId: string, onEvent: (event: StreamEvent) => void): () => void;

    /**
     * 可选：回答一次挂起的提问（整批一次提交）。
     * 服务端会校验题集（少题 / 多题 → 抛错，文案说明差哪几题）。
     */
    answerAsk?(entityId: string, askId: string, answer: AskAnswer): Promise<void>;

    /** 可选：撤回一问（不想答了）—— 卡片失效，不触发任何运行 */
    cancelAsk?(entityId: string, askId: string): Promise<void>;
}
