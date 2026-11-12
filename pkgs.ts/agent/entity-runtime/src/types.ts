// types.ts —— 端到端切片的最小契约（无兼容负担，随时可改）。
//
// 四件事：
//   Item       UI 只认识的展示条目（type + data，公共字段在外）
//   AgentEvent 模型运行的原始事件（seq 单调）
//   InboxItem  actor 的待消费队列项（状态表，可 claimed）
//   Entity     项目/任务/bot 的统一入口（bot 也是实体）

export type EntityKind = 'project' | 'task' | 'bot';

export interface Entity {
    id: string;
    kind: EntityKind;
    name: string;
    /** 项目/任务目录；bot 可以有自己的目录 */
    dir?: string;
    /** 任务所属项目 */
    projectId?: string;
    /** 参与者；第一个是 owner */
    botIds: string[];
    /** 默认模型（account@provider/model） */
    modelKey: string;
}

export interface Bot {
    id: string;
    name: string;
    color: string;
    persona: string;
    /** 归属实体（创建它的地方） */
    homeEntityId: string;
    /** bot 自己的目录（可选） */
    homeDir?: string;
    modelKey: string;
}

export interface Author {
    id: string;
    name: string;
    color: string;
    role: 'human' | 'bot' | 'system';
}

interface ItemBase {
    id: string;
    seq: number;
    turnId: string;
    at: number;
    status: 'pending' | 'streaming' | 'done' | 'failed';
    author?: Author;
}

export type Item =
    | (ItemBase & { type: 'chat'; data: { text: string } })
    | (ItemBase & { type: 'notice'; data: { text: string; kind: string } })
    | (ItemBase & { type: 'tool'; data: { name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' } })
    | (ItemBase & { type: 'error'; data: { message: string } });

/** 模型运行事件（seq 单调；投影到 Item 后 UI 才消费） */
export type AgentEvent =
    | { seq: number; type: 'run.started'; turnId: string; messageId: string }
    | { seq: number; type: 'text.delta'; messageId: string; delta: string }
    | { seq: number; type: 'reasoning.delta'; messageId: string; delta: string }
    | { seq: number; type: 'tool.started'; turnId: string; toolCallId: string; name: string; args?: unknown }
    | { seq: number; type: 'tool.completed'; turnId: string; toolCallId: string; name: string; result?: unknown; error?: string }
    | { seq: number; type: 'message.completed'; messageId: string }
    | { seq: number; type: 'run.completed'; turnId: string }
    | { seq: number; type: 'run.failed'; turnId: string; message: string };

export type InboxMode = 'next-turn' | 'next-step' | 'now';

export interface InboxItem {
    id: string;
    actor: string;
    seq: number;
    mode: InboxMode;
    kind: 'chat' | 'notice';
    payload: Record<string, unknown>;
    status: 'pending' | 'claimed';
    createdAt: number;
    claimedAt?: number;
}
