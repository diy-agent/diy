// @diy-agent/protocol —— 实体对话的协议层：只有类型，没有实现。
//
// 依赖规则（硬）：禁止 import React / node / 任何 UI kit / 任何 runtime 包。
// 后端（entity-runtime / server）与前端（chat-core / surface）共用这里的定义，
// 保证「后端产出的事件」与「前端消费的事件」是同一个类型，不靠约定同步。

// ── 实体 / 参与者 ──────────────────────────────────────────────

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

// ── 展示条目（UI 只消费这些）────────────────────────────────────

export type ItemStatus = 'pending' | 'streaming' | 'done' | 'failed';

interface ItemBase {
    id: string;
    /** 存储层单调序号（同一实体） */
    seq: number;
    /** 展示顺序（服务端首次出现时分配；跨 bot 也稳定） */
    order?: number;
    /** 会话内的轮次序号（发送时分配；老数据可能没有） */
    turn?: number;
    turnId: string;
    at: number;
    status: ItemStatus;
    author?: Author;
}

export type Item =
    | (ItemBase & { type: 'chat'; data: { text: string } })
    | (ItemBase & { type: 'notice'; data: { text: string; kind: string } })
    | (ItemBase & { type: 'tool'; data: { name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' } })
    | (ItemBase & { type: 'error'; data: { message: string } });

// ── 投递（消息 → bot 的到达状态）────────────────────────────────

export type DeliveryState = 'queued' | 'delivering' | 'delivered' | 'failed' | 'skipped';

export interface Delivery {
    entityId: string;
    messageId: string;
    botId: string;
    state: DeliveryState;
    note?: string;
    updatedAt: number;
}

// ── 命令 / 事件（前后端唯一契约）────────────────────────────────

export type Command =
    | { kind: 'send'; text: string }
    | { kind: 'cancel'; keepInbox?: boolean };

/** 传输层回推给 UI 的事件流（目前是 SSE，将来可能是 diy-rpc 订阅） */
export type StreamEvent =
    | { kind: 'item'; item: Item }
    | { kind: 'delivery'; delivery: Delivery }
    | { kind: 'error'; message: string }
    | { kind: 'done' };

export interface Snapshot {
    items: Item[];
    deliveries: Delivery[];
}

/** capabilities 决定 UI 显示哪些按钮（不要写 surfaceId 分支） */
export interface Capabilities {
    steer: boolean;
    approval: boolean;
    multiAgent: boolean;
    replay: boolean;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
    steer: false,
    approval: false,
    multiAgent: true,
    replay: false,
};

// ── 运行时事件（模型 → 投影层）───────────────────────────────────

/** 模型运行的原始事件（seq 单调；投影成 Item 后 UI 才消费） */
export type AgentEvent =
    | { seq: number; type: 'run.started'; turnId: string; messageId: string }
    | { seq: number; type: 'text.delta'; messageId: string; delta: string }
    | { seq: number; type: 'reasoning.delta'; messageId: string; delta: string }
    | { seq: number; type: 'tool.started'; turnId: string; toolCallId: string; name: string; args?: unknown }
    | { seq: number; type: 'tool.completed'; turnId: string; toolCallId: string; name: string; result?: unknown; error?: string }
    | { seq: number; type: 'message.completed'; messageId: string }
    | { seq: number; type: 'run.completed'; turnId: string }
    | { seq: number; type: 'run.failed'; turnId: string; message: string };

// ── actor 收件箱（后端内部，但类型放这里以便将来跨进程）─────────

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
