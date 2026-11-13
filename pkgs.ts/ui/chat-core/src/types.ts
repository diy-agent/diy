// types.ts —— UI 与后端之间的唯一契约（纯类型，禁止 import React / node / 任何 UI kit）。

export type EntityKind = 'project' | 'task' | 'bot';

export interface Entity {
    id: string;
    kind: EntityKind;
    name: string;
    dir?: string;
    projectId?: string;
    botIds: string[];
    modelKey: string;
}

export interface Bot {
    id: string;
    name: string;
    color: string;
    persona: string;
    homeEntityId: string;
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
    /** 展示顺序（后端分配；跨 bot 稳定） */
    order?: number;
    /** 会话内轮次序号（后端在发送时分配；老数据可能没有） */
    turn?: number;
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

export type DeliveryState = 'queued' | 'delivering' | 'delivered' | 'failed' | 'skipped';

export interface Delivery {
    entityId: string;
    messageId: string;
    botId: string;
    state: DeliveryState;
    note?: string;
    updatedAt: number;
}

// ── 命令 / 事件 ────────────────────────────────────────────────

export type Command =
    | { kind: 'send'; text: string }
    | { kind: 'cancel'; keepInbox?: boolean };

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
