// projection.ts —— AgentEvent → Item（UI 只消费 Item）。
//
// 关键约定：
//   · **懒创建** assistant 消息：run.started 不落空消息，否则 UI 会多一个闪烁占位；
//     只有真的出现 text / tool 时才落第一条 Item。
//   · **文本分段**：一次 tool 调用会把「说一段 → 调工具 → 再说一段」切成两段。
//     每段是独立 Item（id = `${messageId}#N`），时间线里才能 text → tool → text 地交错，
//     而不是把所有文本并成一块、永远排在工具前面。

import type { AgentEvent, Author, Item } from './types';

let counter = 0;
export const nextId = (prefix: string): string => `${prefix}-${++counter}`;

export class Projector {
    private readonly items = new Map<string, Item>();
    /** `${messageId}#${segment}` → item.id */
    private readonly messageIds = new Map<string, string>();
    private readonly toolIds = new Map<string, string>();
    private seq = 0;
    /** run.started 之后、还没有真实内容之前：先记住，别落空消息 */
    private pending: { messageId: string; turnId: string; at: number } | null = null;
    /** 同一个 messageId 里的第几段文本（每次工具调用后 +1） */
    private segment = 0;

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

    /**
     * 首次出现内容时，才把当前段落的 assistant 消息落下来。
     * 工具调用之后 segment 会 +1，于是下一段文本是一条新 Item。
     */
    private ensureMessage(seq: number, now: number): Item | null {
        if (this.pending === null) return null;
        const key = `${this.pending.messageId}#${this.segment}`;
        const existing = this.messageIds.get(key);
        if (existing !== undefined) {
            const current = this.items.get(existing);
            return current ?? null;
        }
        const item: Item = {
            id: this.segment === 0 ? this.pending.messageId : `${this.pending.messageId}#${this.segment}`,
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
        this.messageIds.set(key, item.id);
        return item;
    }

    /** 当前段落收尾（工具开始 / 消息完成时调用） */
    private closeSegment(seq: number): Item | null {
        if (this.pending === null) return null;
        const id = this.messageIds.get(`${this.pending.messageId}#${this.segment}`);
        if (id === undefined) return null;
        const current = this.items.get(id);
        if (current === undefined || current.status !== 'streaming') return null;
        const next: Item = { ...current, seq, status: 'done' };
        this.items.set(id, next);
        return next;
    }

    apply(event: AgentEvent, now = Date.now()): Item[] {
        this.seq = Math.max(this.seq, event.seq);
        const seq = this.seq;

        switch (event.type) {
            case 'run.started': {
                this.pending = { messageId: event.messageId, turnId: event.turnId, at: now };
                this.segment = 0;
                return [];
            }

            case 'text.delta': {
                this.ensureMessage(seq, now);
                const id = this.messageIds.get(`${event.messageId}#${this.segment}`);
                if (id === undefined) return [];
                const current = this.items.get(id);
                if (current === undefined || current.type !== 'chat') return [];
                const chat = current as Extract<Item, { type: 'chat' }>;
                const next: Item = { ...chat, seq, data: { text: chat.data.text + event.delta } };
                this.items.set(id, next);
                return [next];
            }

            case 'message.completed': {
                const closed = this.closeSegment(seq);
                return closed === null ? [] : [closed];
            }

            case 'tool.started': {
                if (this.toolIds.has(event.toolCallId)) return [];
                // 先把正在写的这段文本收尾，再落工具块
                const closed = this.closeSegment(seq);
                const ops: Item[] = closed === null ? [] : [closed];

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
                ops.push(item);

                // 之后的文本属于新的一段
                this.segment += 1;
                return ops;
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
                // 中止/失败时把**所有**还在 streaming 的条目收尾：
                // 之前只关了最后一条 chat，正在跑的工具会永远显示"Running tool: xxx"。
                const ops: Item[] = [];
                for (const [id, open] of this.items) {
                    if (open.status !== 'streaming') continue;
                    const closed: Item =
                        open.type === 'tool'
                            ? { ...open, seq, status: 'failed', data: { ...open.data, state: 'error' } }
                            : { ...open, seq, status: 'failed' };
                    this.items.set(id, closed);
                    ops.push(closed);
                }
                const err: Item = {
                    id: nextId('err'),
                    seq,
                    turn: this.turn,
                    turnId: event.turnId,
                    at: now,
                    status: 'failed',
                    author: this.author,
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
