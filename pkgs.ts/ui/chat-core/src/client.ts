// client.ts —— ChatClient 契约（纯接口）。
//
// 这一层不认识 HTTP / SSE / WebSocket / ipc：传输实现放在独立的 transport 包里。
//   现在：@diy-agent/chat-transport-http
//   将来：@diy-agent/chat-transport-rpc（diy-rpc 落地后直接换实现，core 不动）

import type { Command, Snapshot, StreamEvent } from './types';

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
    summarized: boolean;
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
    event: CompactEventInfo | null;
    stats: SessionStats;
}

export interface ChatClient {
    /** 拉历史快照（首屏 / 重载 / 重放） */
    load(entityId: string): Promise<Snapshot>;

    /** 提交命令；事件通过 onEvent 回推。signal 取消只影响本地订阅。 */
    post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>;

    /** 可选：上下文观测（后端支持才有） */
    sessions?(entityId: string): Promise<SessionInfo[]>;

    /** 可选：手动压缩某个 bot 的上下文（只影响它自己，不触发运行） */
    compact?(entityId: string, botId: string, options?: { keepLast?: number; maxChars?: number }): Promise<CompactOutcome>;

    /** 可选：工具审批（允许 / 拒绝一次挂起的工具调用） */
    approve?(entityId: string, approvalId: string, approved: boolean, reason?: string): Promise<void>;
}
