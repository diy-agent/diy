// session.ts —— BotSession：某个 bot 在某个 room 里的那条原生单线对话。
//
// 职责：
//   · 串行：同一 session 同时只跑一个 turn
//   · 两个投递时机：next-step（step 边界插入，用 SDK 的 steering） / next-turn（等这轮结束）
//   · cancel：abort + 清空队列；keepQueue 时降级为 next-turn
//   · 自己的上下文自己攒：公共条目由房间 ingest 进来，私有过程来自本轮的模型产出
//   · 压缩：交给可替换的 Compactor（默认 simpleCompactor），**只压自己**，不产生公共产物
//
// 不做：路由、持久化、SSE —— 那些通过回调交给调用方（server / 未来的 kernel）。

import { experimental_createSteering, type Experimental_Steering, type ModelMessage } from 'ai';

import { runAgent, type RunOptions } from './agent';
import {
    DEFAULT_BUDGET,
    estimateChars,
    simpleCompactor,
    type CompactEvent,
    type CompactionBudget,
    type Compactor,
    type TokenUsage,
    type TranscriptEntry,
} from './compaction';
import { Projector } from './projection';
import { toMessage, type RoomEntry } from './room-log';
import type { AgentEvent, Author, Bot, Item } from './types';

export interface CompactOptions {
    keepLast?: number;
    maxChars?: number;
}

/** @deprecated 用 DEFAULT_BUDGET；保留导出避免调用方一次改太多 */
export const DEFAULT_COMPACT = DEFAULT_BUDGET;

export interface TurnResult {
    turn: number;
    turnId: string;
    /** 本轮产出的全部文本（房间层据此写"结论"条目） */
    text: string;
    failed: boolean;
    /** 本轮实测用量（真实 token，可用于校准预算） */
    usage?: TokenUsage;
}

export interface SessionStats {
    entries: number;
    chars: number;
    /** 当前生效的默认预算（自动压缩与手动压缩都用它，可被入参覆盖） */
    budget: CompactionBudget;
    /** 历史累计丢弃条数 */
    collapsed: number;
    compactions: number;
    lastCompactAt?: number;
    strategy: string;
    usage?: TokenUsage;
}

export interface SessionDeps {
    /** `${roomId}::${botId}` */
    actor: string;
    bot: Bot;
    modelKey: string;
    /** 首次开跑前的种子；内存版不提供（接持久化后用它回放） */
    seed?: () => TranscriptEntry[];
    /** 分配轮次号 / id（由容器决定，跨 bot 稳定） */
    nextTurn: () => { turn: number; turnId: string };
    /** 展示顺序 */
    nextOrder: () => number;
    onItem: (item: Item) => void;
    onError: (message: string) => void;
    /** 投递状态变化（messageId → delivering/delivered/failed） */
    onDelivery?: (messageId: string, state: 'delivering' | 'delivered' | 'failed') => void;
    /** 一轮结束：把结论交给房间层写公共日志（**不唤醒任何人**） */
    onTurnEnd?: (result: TurnResult) => void;
    /** 压缩策略；默认 simpleCompactor */
    compactor?: Compactor;
    /** 默认预算（策略可自行决定是否使用） */
    budget?: CompactOptions;
    /** 每次真的压了都会回调一条事件（日志 / 调试端点用） */
    onCompact?: (event: CompactEvent) => void;
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
    private transcript: TranscriptEntry[];
    /** 已 ingest、还没并进 transcript 的公共条目（运行中到达的要排在本轮产出之后） */
    private pending: TranscriptEntry[] = [];
    private running = false;
    private steering: Experimental_Steering | null = null;
    private abort: AbortController | null = null;
    /** cancel({keepQueue:true}) 期间被 abort 的 next-step 要降级为下一轮，不能丢 */
    private keepOnCancel = false;
    /** 已被压缩掉的早期消息条数 */
    private collapsed = 0;
    /** 压缩事件（最近 N 条，调试用） */
    private readonly events: CompactEvent[] = [];
    /** 上一轮实测用量：给策略做真实 token 判据 */
    private lastUsage: TokenUsage | undefined;
    /** 最近一次运行的轮次号（手动压缩时用它，不额外消耗轮次） */
    private turnNow = 0;

    constructor(private readonly deps: SessionDeps) {
        this.transcript = deps.seed?.() ?? [];
    }

    get busy(): boolean {
        return this.running;
    }

    /** 当前上下文快照（调试 / 测试用）：已并入的 + 待并入的 */
    context(): readonly ModelMessage[] {
        return [...this.transcript, ...this.pending].map((entry) => entry.message);
    }

    stats(): SessionStats {
        // 待并入的公共条目也算"当前上下文"，否则长时间没跑的 bot 看起来是空的
        const entries = [...this.transcript, ...this.pending];
        return {
            entries: entries.length,
            chars: estimateChars(entries),
            budget: this.budgetWith({}),
            collapsed: this.collapsed,
            compactions: this.events.length,
            ...(this.events.at(-1) === undefined ? {} : { lastCompactAt: this.events.at(-1)!.at }),
            strategy: this.compactor.name,
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
    }

    compactions(): readonly CompactEvent[] {
        return this.events;
    }

    /** 房间公共条目 → 自己这一侧的一条消息；不触发任何运行 */
    ingest(entry: RoomEntry): void {
        const message = toMessage(entry, this.deps.bot.id);
        if (message === null) return;
        this.pending.push({ message, origin: 'public', ...(entry.turn === undefined ? {} : { turn: entry.turn }) });
    }

    /**
     * 手动压一次（只影响自己，不触发运行）。方便调参：
     *   POST /api/rooms/:id/sessions/:botId/compact { keepLast, maxChars }
     */
    async forceCompact(options: CompactOptions = {}): Promise<CompactEvent | null> {
        const budget = this.budgetWith(options);
        return this.compact({ force: true, turn: this.turnNow, turnId: `force-${Date.now().toString(36)}`, budget });
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

    private get compactor(): Compactor {
        return this.deps.compactor ?? simpleCompactor;
    }

    private budgetWith(options: CompactOptions): CompactionBudget {
        return {
            keepLast: options.keepLast ?? this.deps.budget?.keepLast ?? DEFAULT_BUDGET.keepLast,
            maxChars: options.maxChars ?? this.deps.budget?.maxChars ?? DEFAULT_BUDGET.maxChars,
        };
    }

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
        this.turnNow = turn;
        const projector = new Projector(this.authorOf(), turn);
        const abort = new AbortController();
        this.abort = abort;

        // 开跑前先把已到的公共条目并进来，再按自己的预算压一次（压不压只看自己）
        this.drainPending();
        await this.compact({ turn, turnId });

        // 本轮要处理的用户消息直接作为 prompt 的一部分（不出现在别处，避免重复记账）
        const userEntries: TranscriptEntry[] = items.map((item) => ({
            message: { role: 'user', content: item.text },
            origin: 'public',
            ...(item.turn === undefined ? {} : { turn: item.turn.turn }),
        }));
        const messages: ModelMessage[] = [...this.transcript, ...userEntries].map((entry) => entry.message);

        const steering = experimental_createSteering();
        this.steering = steering;
        for (const item of items) this.deps.onDelivery?.(item.messageId, 'delivering');

        const produced: TranscriptEntry[] = [];
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
                onStepTranscript: (added) => {
                    for (const message of added) produced.push({ message, origin: 'self', turn });
                },
                onUsage: (usage) => {
                    this.lastUsage = usage;
                },
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
            this.transcript.push(...userEntries, ...produced);
            // 跑的过程中到达的公共条目：排在本轮产出之后，下一轮才被读到
            this.drainPending();

            // 先把结论交给房间层（写公共日志 + 复制给其他 session），再 resolve
            if (!failed) {
                try {
                    this.deps.onTurnEnd?.({
                        turn,
                        turnId,
                        text: text.trim(),
                        failed,
                        ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
                    });
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

    /**
     * 调策略压一次并记账。策略自己决定要不要压（返回 null = 不压）。
     * 这里只做：计时、统计前后规模、更新占位说明、发事件。
     */
    private async compact(options: { turn: number; turnId: string; budget?: CompactionBudget; force?: boolean }): Promise<CompactEvent | null> {
        const budget = options.budget ?? this.budgetWith({});
        const before = { entries: this.transcript.length, chars: estimateChars(this.transcript) };
        const startedAt = Date.now();

        const result = await this.compactor.compact({
            entries: this.transcript,
            budget,
            turn: options.turn,
            turnId: options.turnId,
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
            ...(options.force === true ? { force: true } : {}),
        });
        if (result === null) return null;

        this.transcript = result.entries;
        this.collapsed += result.dropped;
        this.applyCollapsedNote();

        const event: CompactEvent = {
            at: Date.now(),
            strategy: this.compactor.name,
            turn: options.turn,
            turnId: options.turnId,
            durationMs: Date.now() - startedAt,
            budget,
            before,
            after: { entries: this.transcript.length, chars: estimateChars(this.transcript) },
            folded: result.folded,
            dropped: result.dropped,
            summarized: result.summarized,
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
        this.events.push(event);
        if (this.events.length > 10) this.events.shift();
        this.deps.onCompact?.(event);
        return event;
    }

    /** 占位说明只保留一条，且始终在最前面 */
    private applyCollapsedNote(): void {
        if (this.collapsed === 0) return;
        if (this.transcript[0]?.origin === 'note') this.transcript.shift();
        this.transcript.unshift({
            message: { role: 'user', content: `[更早的 ${this.collapsed} 条消息已折叠]` },
            origin: 'note',
        });
    }

    private drainPending(): void {
        if (this.pending.length === 0) return;
        this.transcript.push(...this.pending);
        this.pending = [];
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
