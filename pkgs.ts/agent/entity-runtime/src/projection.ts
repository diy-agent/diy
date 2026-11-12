// projection.ts —— AgentEvent → Item（纯内存投影；流式 delta 折进同一条 Item）。
//
// 约定：每次事件返回「发生变化的 Item 列表」，调用方把它们 upsert 给 UI。
// UI 不需要知道 delta、工具三态这些细节。

import type { AgentEvent, Author, Item } from './types';

let counter = 0;
export const nextId = (prefix: string): string => `${prefix}-${++counter}`;

export class Projector {
    private readonly items = new Map<string, Item>();
    private readonly messageIds = new Map<string, string>();
    private readonly toolIds = new Map<string, string>();
    private seq = 0;

    constructor(private readonly author: Author) {}

    all(): Item[] {
        return [...this.items.values()].sort((a, b) => a.seq - b.seq);
    }

    /** 注入一条非 agent 产生的 Item（用户消息 / notice） */
    add(item: Item): Item {
        this.items.set(item.id, item);
        this.seq = Math.max(this.seq, item.seq);
        return item;
    }

    apply(event: AgentEvent, now = Date.now()): Item[] {
        this.seq = Math.max(this.seq, event.seq);
        const seq = this.seq;

        switch (event.type) {
            case 'run.started': {
                const item: Item = {
                    id: event.messageId,
                    seq,
                    turnId: event.turnId,
                    at: now,
                    status: 'streaming',
                    author: this.author,
                    type: 'chat',
                    data: { text: '' },
                };
                this.items.set(item.id, item);
                this.messageIds.set(event.messageId, item.id);
                return [item];
            }

            case 'text.delta': {
                const id = this.messageIds.get(event.messageId);
                if (id === undefined) return [];
                const current = this.items.get(id);
                if (current === undefined || current.type !== 'chat') return [];
                const next: Item = { ...current, seq, data: { text: current.data.text + event.delta } };
                this.items.set(id, next);
                return [next];
            }

            case 'message.completed': {
                const id = this.messageIds.get(event.messageId);
                if (id === undefined) return [];
                const current = this.items.get(id);
                if (current === undefined) return [];
                const next: Item = { ...current, seq, status: 'done' };
                this.items.set(id, next);
                return [next];
            }

            case 'tool.started': {
                if (this.toolIds.has(event.toolCallId)) return [];
                const id = `tool-${event.toolCallId}`;
                const item: Item = {
                    id,
                    seq,
                    turnId: event.turnId,
                    at: now,
                    status: 'streaming',
                    author: this.author,
                    type: 'tool',
                    data: { name: event.name, args: event.args, state: 'running' },
                };
                this.items.set(id, item);
                this.toolIds.set(event.toolCallId, id);
                return [item];
            }

            case 'tool.completed': {
                const id = this.toolIds.get(event.toolCallId);
                if (id === undefined) return [];
                const current = this.items.get(id);
                if (current === undefined || current.type !== 'tool') return [];
                const failed = event.error !== undefined;
                const next: Item = {
                    ...current,
                    seq,
                    status: failed ? 'failed' : 'done',
                    data: { name: event.name, args: current.data.args, result: event.result, state: failed ? 'error' : 'ok' },
                };
                this.items.set(id, next);
                return [next];
            }

            case 'run.failed': {
                const item: Item = {
                    id: nextId('err'),
                    seq,
                    turnId: event.turnId,
                    at: now,
                    status: 'failed',
                    type: 'error',
                    data: { message: event.message },
                };
                this.items.set(item.id, item);
                return [item];
            }

            default:
                return [];
        }
    }
}
