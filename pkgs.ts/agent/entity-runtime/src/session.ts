// session.ts —— BotSession：某个 bot 在某个 room 里的那条原生单线对话。
//
// 职责：
//   · 串行：同一 session 同时只跑一个 turn
//   · 两个投递时机：next-step（step 边界插入，用 SDK 的 steering） / next-turn（等这轮结束）
//   · cancel：abort + 清空队列；keepQueue 时降级为 next-turn
//   · 自己的上下文自己攒：公共条目由房间 ingest 进来，私有过程（tool/reasoning）来自本轮的模型产出
//   · 压缩：**只压自己**，不产生公共产物、不通知任何人、不推进任何全局状态
//
// 不做：路由、持久化、SSE —— 那些通过回调交给调用方（server / 未来的 kernel）。

import { experimental_createSteering, type Experimental_Steering, type ModelMessage } from 'ai';

import { runAgent, type RunOptions } from './agent';
import { Projector } from './projection';
import { toMessage, type RoomEntry } from './room-log';
import type { AgentEvent, Author, Bot, Item } from './types';

export interface CompactOptions {
    /** 原样保留的最近消息数（不折叠、不丢弃） */
    keepLast?: number;
    /** 估算字符预算；超了才压（先折叠私有工具过程，再丢最老的整条） */
    maxChars?: number;
}

export const DEFAULT_COMPACT: Required<CompactOptions> = { keepLast: 12, maxChars: 24000 };

export interface TurnResult {
    turn: number;
    turnId: string;
    /** 本轮产出的全部文本（房间层据此写"结论"条目） */
    text: string;
    failed: boolean;
}

export interface SessionDeps {
    /** `${roomId}::${botId}` */
    actor: string;
    bot: Bot;
    modelKey: string;
    /** 首次开跑前的种子；内存版不提供（接持久化后用它回放） */
    seed?: () => ModelMessage[];
    /** 分配轮次号 / id（由容器决定，跨 bot 稳定） */
    nextTurn: () => { turn: number; turnId: string };
    /** 展示顺序 */
    nextOrder: () => number;
    /** 落盘 + 广播（done / failed 的条目调用方负责持久化） */
    onItem: (item: Item) => void;
    onError: (message: string) => void;
    /** 投递状态变化（messageId → delivering/delivered/failed） */
    onDelivery?: (messageId: string, state: 'delivering' | 'delivered' | 'failed') => void;
    /** 一轮结束：把结论交给房间层写公共日志（**不唤醒任何人**） */
    onTurnEnd?: (result: TurnResult) => void;
    compact?: CompactOptions;
    /** 便于测试注入；默认用 runAgent（真实模型） */
    run?: (input: RunOptions) => AsyncIterable<AgentEvent>;
}

interface QueueItem {
    messageId: string;
    text: string;
    mode: 'next-step' | 'next-turn';
    /** 容器分配的轮次（同一条用户消息的所有 bot 共享） */
    turn?: { turn: number; turnId: string };
    /** 这条消息在房间日志里的条目：steering 没送到时兜底 ingest，避免丢掉 */
    entry?: RoomEntry;
    resolve: () => void;
}

export class BotSession {
    private readonly queue: QueueItem[] = [];
    /** 自己的原生对话（本轮之前的全部内容） */
    private transcript: ModelMessage[];
    /** 已 ingest、还没并进 transcript 的公共条目（运行中到达的要排在本轮产出之后） */
    private pending: ModelMessage[] = [];
    private running = false;
    private steering: Experimental_Steering | null = null;
    private abort: AbortController | null = null;
    /** cancel({keepQueue:true}) 期间被 abort 的 next-step 要降级为下一轮，不能丢 */
    private keepOnCancel = false;
    /** 已被压缩掉的早期消息条数 */
    private collapsed = 0;

    constructor(private readonly deps: SessionDeps) {
        this.transcript = deps.seed?.() ?? [];
    }

    get busy(): boolean {
        return this.running;
    }

    /** 当前上下文快照（调试 / 测试用）：已并入的 + 待并入的 */
    context(): readonly ModelMessage[] {
        return [...this.transcript, ...this.pending];
    }

    /** 房间公共条目 → 自己这一侧的一条消息；不触发任何运行 */
    ingest(entry: RoomEntry): void {
        const message = toMessage(entry, this.deps.bot.id);
        if (message === null) return;
        this.pending.push(message);
    }

    /** 投一条消息；返回的 promise 在它所属 turn 结束时 resolve */
    post(input: {
        messageId: string;
        text: string;
        mode?: 'next-step' | 'next-turn';
        turn?: { turn: number; turnId: string };
        entry?: RoomEntry;
    }): Promise<void> {
        const mode = input.mode ?? 'next-step';
        const { promise, resolve } = withResolve();

        // 正在跑且是 next-step：直接交给 SDK，在下一个 step 边界插入
        if (this.running && mode === 'next-step' && this.steering !== null) {
            this.deps.onDelivery?.(input.messageId, 'delivering');
            void this.steering.steer(input.text, { id: input.messageId }).then((outcome) => {
                if (outcome.type === 'delivered') {
                    this.deps.onDelivery?.(input.messageId, 'delivered');
                    return;
                }
                if (this.keepOnCancel) {
                    // 被 cancel 打断：降级为下一轮
                    this.queue.push({ messageId: input.messageId, text: input.text, mode: 'next-turn', turn: input.turn, entry: input.entry, resolve });
                    return;
                }
                // 没送进这一轮：至少让公共条目留在自己的上下文里，别静默丢失
                if (input.entry !== undefined) this.ingest(input.entry);
                this.deps.onDelivery?.(input.messageId, 'failed');
            });
            this.pendingResolvers.push(resolve);
            return promise;
        }

        this.queue.push({ messageId: input.messageId, text: input.text, mode, turn: input.turn, entry: input.entry, resolve });
        void this.pump();
        return promise;
    }

    /** 停止当前 turn：默认丢弃未消费的消息；keepQueue 时降级为下一轮 */
    cancel(options: { keepQueue?: boolean } = {}): void {
        this.keepOnCancel = options.keepQueue === true;
        const rest = this.queue.splice(0, this.queue.length);
        for (const item of rest) {
            if (options.keepQueue === true) {
                item.mode = 'next-turn';
                this.queue.push(item);
            } else {
                item.resolve();
            }
        }
        this.abort?.abort();
    }

    private pendingResolvers: Array<() => void> = [];

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length > 0) {
                const items = this.queue.splice(0, this.queue.length);
                await this.runTurn(items);
            }
        } finally {
            this.running = false;
            this.steering = null;
            const resolvers = this.pendingResolvers.splice(0, this.pendingResolvers.length);
            for (const resolve of resolvers) resolve();
        }
    }

    private async runTurn(items: QueueItem[]): Promise<void> {
        const { turn, turnId } = items[0]?.turn ?? this.deps.nextTurn();
        const projector = new Projector(this.authorOf(), turn);
        const abort = new AbortController();
        this.abort = abort;

        // 开跑前先把已到的公共条目并进来，再按自己的预算压一次（压不压只看自己）
        this.drainPending();
        this.compact();
        // 本轮要处理的用户消息直接作为 prompt 的一部分（不出现在别处，避免重复记账）
        const userMessages: ModelMessage[] = items.map((item) => ({ role: 'user', content: item.text }));
        const messages = [...this.transcript, ...userMessages];

        const steering = experimental_createSteering();
        this.steering = steering;
        for (const item of items) this.deps.onDelivery?.(item.messageId, 'delivering');

        const produced: ModelMessage[] = [];
        let text = '';
        let failed = false;
        try {
            const run = this.deps.run ?? runAgent;
            for await (const event of run({
                bot: this.deps.bot,
                modelKey: this.deps.modelKey,
                messages,
                turnId,
                signal: abort.signal,
                steering,
                onStepTranscript: (added) => produced.push(...added),
            })) {
                if (event.type === 'run.failed') failed = true;
                if (event.type === 'text.delta') text += event.delta;
                for (const item of projector.apply(event)) {
                    const ordered: Item = item.order === undefined ? { ...item, order: this.deps.nextOrder() } : item;
                    this.deps.onItem(ordered);
                }
            }
        } catch (error) {
            failed = true;
            this.deps.onError(error instanceof Error ? error.message : String(error));
        } finally {
            // 本轮真正发生过的内容（含自己的 tool / reasoning）原样入账
            this.transcript.push(...userMessages, ...produced);
            // 跑的过程中到达的公共条目：排在本轮产出之后，下一轮才被读到
            this.drainPending();

            // 先把结论交给房间层（写公共日志 + 复制给其他 session），再 resolve
            if (!failed) {
                try {
                    this.deps.onTurnEnd?.({ turn, turnId, text: text.trim(), failed });
                } catch {
                    // 结论发布失败不该把这一轮判成失败
                }
            }

            for (const item of items) this.deps.onDelivery?.(item.messageId, failed ? 'failed' : 'delivered');
            for (const item of items) item.resolve();
            this.steering = null;
            this.abort = null;
            this.keepOnCancel = false;
        }
    }

    private drainPending(): void {
        if (this.pending.length === 0) return;
        this.transcript.push(...this.pending);
        this.pending = [];
    }

    /**
     * 压缩自己的上下文。顺序：
     *   1. 折叠私有过程：丢掉 tool 消息、assistant 只留文本（工具调用/推理不进后续上下文）
     *   2. 还超预算：从最老的整条丢，留一句占位
     * 公共条目（人话 / 别人的结论）在第 1 步**不动**，只可能在第 2 步整条丢弃。
     */
    private compact(): void {
        const keepLast = this.deps.compact?.keepLast ?? DEFAULT_COMPACT.keepLast;
        const maxChars = this.deps.compact?.maxChars ?? DEFAULT_COMPACT.maxChars;
        if (estimate(this.transcript) <= maxChars) return;

        const keepFrom = Math.max(0, this.transcript.length - keepLast);
        const next: ModelMessage[] = [];
        for (let i = 0; i < this.transcript.length; i++) {
            const message = this.transcript[i]!;
            if (i >= keepFrom) {
                next.push(message);
                continue;
            }
            if (message.role === 'tool') continue;
            if (message.role === 'assistant') {
                const content = Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text') : [];
                if (content.length === 0) continue;
                next.push({ role: 'assistant', content });
                continue;
            }
            next.push(message);
        }
        this.transcript = next;

        if (isCollapsedNote(this.transcript[0])) this.transcript.shift();
        let dropped = 0;
        while (estimate(this.transcript) > maxChars && this.transcript.length > keepLast) {
            this.transcript.shift();
            dropped += 1;
        }
        this.collapsed += dropped;
        if (this.collapsed > 0) this.transcript.unshift(collapsedNote(this.collapsed));
    }

    private authorOf(): Author {
        return { id: this.deps.bot.id, name: this.deps.bot.name, color: this.deps.bot.color, role: 'bot' };
    }
}

function estimate(messages: readonly ModelMessage[]): number {
    let total = 0;
    for (const message of messages) total += JSON.stringify(message).length;
    return total;
}

function collapsedNote(count: number): ModelMessage {
    return { role: 'user', content: `[更早的 ${count} 条消息已折叠]` };
}

function isCollapsedNote(message: ModelMessage | undefined): boolean {
    return message !== undefined && typeof message.content === 'string' && message.content.startsWith('[更早的 ');
}

function withResolve(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
