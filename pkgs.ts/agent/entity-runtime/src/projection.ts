// projection.ts —— AgentEvent → Item（UI 只消费 Item）。
//
// 关键：**懒创建** assistant 消息。
//   run.started 不立刻产生一条空消息，否则 UI 会多一个"闪烁圆点"占位，
//   并触发 assistant-ui 的 optimistic 占位（两个圆点 / 分支 2/2）。
//   只有真正出现 text / tool 时才落第一条 Item。

import type { AgentEvent, Author, Item } from './types';

let counter = 0;
export const nextId = (prefix: string): string => `${prefix}-${++counter}`;

export class Projector {
    private readonly items = new Map<string, Item>();
    private readonly messageIds = new Map<string, string>();
    private readonly toolIds = new Map<string, string>();
    private seq = 0;
    /** run.started 之后、还没有真实内容之前：先记住，别落空消息 */
    private pending: { messageId: string; turnId: string; at: number } | null = null;

    constructor(
        private readonly author: Author,
        private readonly turn: number,
    ) {}

    all(): Item[] {
        return [...this.items.values()].sort((a, b) => a.seq - b.seq);
    }

    add(item: Item): Item {
        this.items.set(item.id, item);
        this.seq = Math.max(this.seq, item.seq);
        return item;
    }

    /** 首次出现内容时，才把那条 assistant 消息落下来 */
    private ensureMessage(seq: number, now: number): Item | null {
        if (this.pending === null) return null;
        const existing = this.messageIds.get(this.pending.messageId);
        if (existing !== undefined) {
            const current = this.items.get(existing);
            return current ?? null;
        }
        const item: Item = {
            id: this.pending.messageId,
            seq,
            turn: this.turn,
            turnId: this.pending.turnId,
            at: this.pending.at ?? now,
            status: 'streaming',
            author: this.author,
            type: 'chat',
            data: { text: '' },
        };
        this.items.set(item.id, item);
        this.messageIds.set(this.pending.messageId, item.id);
        return item;
    }

    apply(event: AgentEvent, now = Date.now()): Item[] {
        this.seq = Math.max(this.seq, event.seq);
        const seq = this.seq;

        switch (event.type) {
            case 'run.started': {
                this.pending = { messageId: event.messageId, turnId: event.turnId, at: now };
                return [];
            }

            case 'text.delta': {
                this.ensureMessage(seq, now);
                const id = this.messageIds.get(event.messageId);
                if (id === undefined) return [];
                const current = this.items.get(id);
                if (current === undefined || current.type !== 'chat') return [];
                const chat = current as Extract<Item, { type: 'chat' }>;
                const next: Item = { ...chat, seq, data: { text: chat.data.text + event.delta } };
                this.items.set(id, next);
                return [next];
            }

            case 'message.completed': {
                const created = this.ensureMessage(seq, now);
                const id = this.messageIds.get(event.messageId);
                if (id === undefined) return created === null ? [] : [created];
                const current = this.items.get(id);
                if (current === undefined) return [];
                const next: Item = { ...current, seq, status: 'done' };
                this.items.set(id, next);
                return [next];
            }

            case 'tool.started': {
                if (this.toolIds.has(event.toolCallId)) return [];
                const created = this.ensureMessage(seq, now);
                const id = `tool-${event.toolCallId}`;
                const item: Item = {
                    id,
                    seq,
                    turn: this.turn,
                    turnId: event.turnId,
                    at: now,
                    status: 'streaming',
                    author: this.author,
                    type: 'tool',
                    data: { name: event.name, args: event.args, state: 'running' },
                };
                this.items.set(id, item);
                this.toolIds.set(event.toolCallId, id);
                return created === null ? [item] : [created, item];
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
                const ops: Item[] = [];
                const openId = [...this.messageIds.values()].at(-1);
                if (openId !== undefined) {
                    const open = this.items.get(openId);
                    if (open !== undefined && open.status === 'streaming') {
                        const closed: Item = { ...open, seq, status: 'failed' };
                        this.items.set(openId, closed);
                        ops.push(closed);
                    }
                }
                const err: Item = {
                    id: nextId('err'),
                    seq,
                    turn: this.turn,
                    turnId: event.turnId,
                    at: now,
                    status: 'failed',
                    type: 'error',
                    data: { message: event.message },
                };
                this.items.set(err.id, err);
                ops.push(err);
                this.pending = null;
                return ops;
            }

            default:
                return [];
        }
    }
}
