// session.ts —— BotSession：某个 bot 在某个 room 里的那条原生单线对话。
//
// 职责（只这一件事）：
//   · 串行：同一 session 同时只跑一个 turn
//   · 两个投递时机：next-step（step 边界插入，用 SDK 的 steering） / next-turn（等这轮结束）
//   · cancel：abort + 清空队列；keepQueue 时降级为 next-turn
//
// 不做：路由、持久化、SSE —— 那些通过回调交给调用方（server / 未来的 kernel）。

import { experimental_createSteering, type Experimental_Steering } from 'ai';

import { runAgent, type RunOptions } from './agent';
import { Projector } from './projection';
import type { AgentEvent, Author, Bot, Item } from './types';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface SessionDeps {
    /** `${roomId}::${botId}` */
    actor: string;
    bot: Bot;
    modelKey: string;
    /** 每次 turn 开始时取历史（含本轮之前的全部消息） */
    history: () => ChatMessage[];
    /** 分配轮次号 / id（由容器决定，跨 bot 稳定） */
    nextTurn: () => { turn: number; turnId: string };
    /** 展示顺序 */
    nextOrder: () => number;
    /** 落盘 + 广播（done / failed 的条目调用方负责持久化） */
    onItem: (item: Item) => void;
    onError: (message: string) => void;
    /** 投递状态变化（messageId → delivered/failed） */
    onDelivery?: (messageId: string, state: 'delivering' | 'delivered' | 'failed') => void;
    /** 便于测试注入；默认用 runAgent（真实模型） */
    run?: (input: RunOptions) => AsyncIterable<AgentEvent>;
}

interface QueueItem {
    messageId: string;
    text: string;
    mode: 'next-step' | 'next-turn';
    /** 容器分配的轮次（同一条用户消息的所有 bot 共享） */
    turn?: { turn: number; turnId: string };
    resolve: () => void;
}

export class BotSession {
    private readonly queue: QueueItem[] = [];
    private running = false;
    private steering: Experimental_Steering | null = null;
    private abort: AbortController | null = null;
    /** cancel({keepQueue:true}) 期间被 abort 的 next-step 要降级为下一轮，不能丢 */
    private keepOnCancel = false;

    constructor(private readonly deps: SessionDeps) {}

    get busy(): boolean {
        return this.running;
    }

    /** 投一条消息；返回的 promise 在它所属 turn 结束时 resolve */
    post(input: {
        messageId: string;
        text: string;
        mode?: 'next-step' | 'next-turn';
        turn?: { turn: number; turnId: string };
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
                    this.queue.push({ messageId: input.messageId, text: input.text, mode: 'next-turn', resolve });
                    return;
                }
                this.deps.onDelivery?.(input.messageId, 'failed');
            });
            this.pendingResolvers.push(resolve);
            return promise;
        }

        this.queue.push({ messageId: input.messageId, text: input.text, mode, turn: input.turn, resolve });
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

        // 本轮开头要送达的消息（空闲时投进来的，第一 step 就会带上）
        const steering = experimental_createSteering();
        this.steering = steering;
        // 注意：steer() 的 promise 在 run 消费后才 resolve，不能 await（会在开跑前死等）
        for (const item of items) {
            this.deps.onDelivery?.(item.messageId, 'delivering');
            void steering.steer(item.text, { id: item.messageId }).then((outcome) => {
                if (outcome.type !== 'delivered') this.deps.onDelivery?.(item.messageId, 'failed');
            });
        }

        let failed = false;
        try {
            const run = this.deps.run ?? runAgent;
            for await (const event of run({
                bot: this.deps.bot,
                modelKey: this.deps.modelKey,
                history: this.deps.history(),
                turnId,
                signal: abort.signal,
                steering,
            })) {
                if (event.type === 'run.failed') failed = true;
                for (const item of projector.apply(event)) {
                    const ordered: Item = item.order === undefined ? { ...item, order: this.deps.nextOrder() } : item;
                    this.deps.onItem(ordered);
                }
            }
        } catch (error) {
            failed = true;
            this.deps.onError(error instanceof Error ? error.message : String(error));
        } finally {
            for (const item of items) this.deps.onDelivery?.(item.messageId, failed ? 'failed' : 'delivered');
            for (const item of items) item.resolve();
            this.steering = null;
            this.abort = null;
            this.keepOnCancel = false;
        }
    }

    private authorOf(): Author {
        return { id: this.deps.bot.id, name: this.deps.bot.name, color: this.deps.bot.color, role: 'bot' };
    }
}

function withResolve(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
