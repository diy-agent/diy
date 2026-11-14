// session.ts —— BotSession：某个 bot 在某个 room 里的那条原生单线对话。
//
// 职责（只有这些）：
//   · 串行：同一 session 同时只跑一个 turn
//   · 两个投递时机：next-step（step 边界插入，用 SDK 的 steering） / next-turn（等这轮结束）
//   · cancel：abort + 清空队列；keepQueue 时降级为 next-turn
//   · 自己的上下文自己攒：公共条目由房间 ingest 进来，私有过程来自本轮的模型产出
//   · 压缩：交给可替换的 Compactor，**只压自己**
//
// **不发起任何房间级动作**：投影出的条目、投递状态、回合结束、压缩事件都通过
// `subscribe()` 交给房间。房间负责编号、持久化、广播、结论发布。
//
// 不做：路由、持久化、SSE —— 那些属于 RoomActor。

import { experimental_createSteering, type Experimental_Steering, type ModelMessage, type ToolSet } from 'ai';

import { runAgent, type RunOptions } from './agent';
import { friendlyError } from './errors';
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
import type { AgentEvent, Author, Bot, DeliveryState, Item } from './types';

export interface CompactOptions {
    keepLast?: number;
    maxChars?: number;
}

/** @deprecated 用 DEFAULT_BUDGET；保留导出避免调用方一次改太多 */
export const DEFAULT_COMPACT = DEFAULT_BUDGET;

export interface Turn {
    turn: number;
    turnId: string;
}

export interface TurnResult extends Turn {
    /** 本轮产出的全部文本（房间层据此写"结论"条目） */
    text: string;
    failed: boolean;
    /** 本轮实测用量（真实 token，可用于校准预算） */
    usage?: TokenUsage;
}

/** session 对外的全部输出（房间订阅它） */
export type SessionEvent =
    /** 投影出的展示条目（order 由房间分配） */
    | { type: 'item'; item: Item }
    /** 投递状态变化 */
    | { type: 'delivery'; messageId: string; state: DeliveryState }
    /** 一轮结束（房间据此写结论） */
    | { type: 'turn.end'; result: TurnResult }
    /** 真压了一次 */
    | { type: 'compact'; event: CompactEvent }
    /** 运行失败（条目层面的失败会以 item 形式出现） */
    | { type: 'error'; message: string }
    /** 开始 / 结束一轮（房间据此维护"谁在说话"） */
    | { type: 'busy'; busy: boolean };

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

/** 恢复一个 session 的持久化状态 */
export interface SessionSeed {
    entries: TranscriptEntry[];
    /** 已折叠掉的条数（占位说明用） */
    collapsed?: number;
    /** 上一轮实测用量（压缩判据用） */
    usage?: TokenUsage;
}

export interface SessionDeps {
    bot: Bot;
    modelKey: string;
    /** 房间分配的回合号（唯一来源；session 自己不开新回合） */
    allocateTurn: () => Turn;
    /** 从持久化恢复（重启 / 后加入） */
    seed?: () => SessionSeed;
    /** 便于测试注入；默认用 runAgent（真实模型） */
    run?: (input: RunOptions) => AsyncIterable<AgentEvent>;
    /** 压缩策略；默认 simpleCompactor */
    compactor?: Compactor;
    budget?: CompactOptions;
    /** 房间装配的工具（不传 = 内置 get_time） */
    tools?: ToolSet;
    toolsHint?: string;
}

interface QueueItem {
    messageId: string;
    text: string;
    mode: 'next-step' | 'next-turn';
    /** 容器分配的轮次（同一条用户消息的所有 bot 共享） */
    turn?: Turn;
    /** 这条消息在房间日志里的条目：steering 没送到时兜底 ingest，避免丢掉 */
    entry?: RoomEntry;
    resolve: () => void;
}

export class BotSession {
    private readonly queue: QueueItem[] = [];
    private readonly listeners = new Set<(event: SessionEvent) => void>();
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
        const seed = deps.seed?.();
        this.transcript = seed?.entries ?? [];
        this.collapsed = seed?.collapsed ?? 0;
        this.lastUsage = seed?.usage;
    }

    get busy(): boolean {
        return this.running;
    }

    /** 房间订阅 session 的全部输出 */
    subscribe(listener: (event: SessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(event: SessionEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // 订阅者的异常不能打断会话
            }
        }
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

    /** 持久化快照（房间在每轮结束 / 压缩后落盘） */
    snapshot(): { turn: number; collapsed: number; entries: TranscriptEntry[]; usage?: TokenUsage } {
        return {
            turn: this.turnNow,
            collapsed: this.collapsed,
            entries: [...this.transcript],
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
    }

    /** 房间公共条目 → 自己这一侧的一条消息；不触发任何运行 */
    ingest(entry: RoomEntry): void {
        const message = toMessage(entry, this.deps.bot.id);
        if (message === null) return;
        this.pending.push({ message, origin: 'public', ...(entry.turn === undefined ? {} : { turn: entry.turn }) });
    }

    /** 手动压一次（只影响自己，不触发运行） */
    async forceCompact(options: CompactOptions = {}): Promise<CompactEvent | null> {
        const budget = this.budgetWith(options);
        return this.compact({ force: true, turn: this.turnNow, turnId: `force-${Date.now().toString(36)}`, budget });
    }

    /** 投一条消息；返回的 promise 在它所属 turn 结束时 resolve */
    post(input: {
        messageId: string;
        text: string;
        mode?: 'next-step' | 'next-turn';
        turn?: Turn;
        entry?: RoomEntry;
    }): Promise<void> {
        const mode = input.mode ?? 'next-step';
        const { promise, resolve } = withResolve();

        // 正在跑且是 next-step：直接交给 SDK，在下一个 step 边界插入
        if (this.running && mode === 'next-step' && this.steering !== null) {
            this.emit({ type: 'delivery', messageId: input.messageId, state: 'delivering' });
            void this.steering.steer(input.text, { id: input.messageId }).then((outcome) => {
                if (outcome.type === 'delivered') {
                    this.emit({ type: 'delivery', messageId: input.messageId, state: 'delivered' });
                    return;
                }
                if (this.keepOnCancel) {
                    // 被 cancel 打断：降级为下一轮
                    this.queue.push({ messageId: input.messageId, text: input.text, mode: 'next-turn', turn: input.turn, entry: input.entry, resolve });
                    return;
                }
                // 没送进这一轮：至少让公共条目留在自己的上下文里，别静默丢失
                if (input.entry !== undefined) this.ingest(input.entry);
                this.emit({ type: 'delivery', messageId: input.messageId, state: 'failed' });
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
        this.emit({ type: 'busy', busy: true });
        try {
            while (this.queue.length > 0) {
                const items = this.queue.splice(0, this.queue.length);
                await this.runTurn(items);
            }
        } finally {
            this.running = false;
            this.steering = null;
            this.emit({ type: 'busy', busy: false });
            const resolvers = this.pendingResolvers.splice(0, this.pendingResolvers.length);
            for (const resolve of resolvers) resolve();
        }
    }

    private async runTurn(items: QueueItem[]): Promise<void> {
        const turn = items[0]?.turn ?? this.deps.allocateTurn();
        this.turnNow = turn.turn;
        const projector = new Projector(this.authorOf(), turn.turn);
        const abort = new AbortController();
        this.abort = abort;

        // 开跑前先把已到的公共条目并进来，再按自己的预算压一次（压不压只看自己）
        this.drainPending();
        await this.compact({ turn: turn.turn, turnId: turn.turnId });

        // 本轮要处理的用户消息直接作为 prompt 的一部分（不出现在别处，避免重复记账）
        const userEntries: TranscriptEntry[] = items.map((item) => ({
            message: { role: 'user', content: item.text },
            origin: 'public',
            ...(item.turn === undefined ? {} : { turn: item.turn.turn }),
        }));
        const messages: ModelMessage[] = [...this.transcript, ...userEntries].map((entry) => entry.message);

        const steering = experimental_createSteering();
        this.steering = steering;
        for (const item of items) this.emit({ type: 'delivery', messageId: item.messageId, state: 'delivering' });

        const produced: TranscriptEntry[] = [];
        let text = '';
        let failed = false;
        try {
            const run = this.deps.run ?? runAgent;
            for await (const event of run({
                bot: this.deps.bot,
                modelKey: this.deps.modelKey,
                messages,
                turnId: turn.turnId,
                signal: abort.signal,
                steering,
                ...(this.deps.tools === undefined ? {} : { tools: this.deps.tools }),
                ...(this.deps.toolsHint === undefined ? {} : { toolsHint: this.deps.toolsHint }),
                onStepTranscript: (added) => {
                    for (const message of added) produced.push({ message, origin: 'self', turn: turn.turn });
                },
                onUsage: (usage) => {
                    this.lastUsage = usage;
                },
            })) {
                if (event.type === 'run.failed') failed = true;
                if (event.type === 'text.delta') text += event.delta;
                for (const item of projector.apply(event)) this.emit({ type: 'item', item });
            }
        } catch (error) {
            failed = true;
            this.emit({ type: 'error', message: friendlyError(error) });
        } finally {
            // 本轮真正发生过的内容（含自己的 tool / reasoning）原样入账
            this.transcript.push(...userEntries, ...produced);
            // 跑的过程中到达的公共条目：排在本轮产出之后，下一轮才被读到
            this.drainPending();

            if (!failed) {
                this.emit({
                    type: 'turn.end',
                    result: {
                        turn: turn.turn,
                        turnId: turn.turnId,
                        text: text.trim(),
                        failed,
                        ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
                    },
                });
            }

            for (const item of items) this.emit({ type: 'delivery', messageId: item.messageId, state: failed ? 'failed' : 'delivered' });
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
        this.emit({ type: 'compact', event });
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
