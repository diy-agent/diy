// progress.ts —— 「这一轮还活着吗」的判据（session 用；假 clock 可直测）。
//
// 存在的理由：`runTurn` 的 for-await 只有在 SDK 肯退出时才会走到 finally ——
// 网关连上不吐字节、流中途静默时，`endReasonOf` 再完美也**永远没机会跑**，
// 用户看到的是"一直转圈"；关掉再打开还是转圈，因为卡住的调用没人管。
//
// 与 `end-reason.ts` 同样的两条纪律：
//   1. **判据只在这一个文件**（不 import agent / db / room）：UI、room、测试共用一份
//   2. **只说事实**：`what`（在等谁）/ `idleMs`（多久没动）/ `alive`（有没有活的证据）；
//      「该怎么跟用户说」在 `end-reason.ts` 的 `endItemsOf` / `adviceOf`
//
// 判定是**分批**的 —— 不是所有 await 都按同一阈值杀：
//   · 模型流：连上了不吐字 = 明确故障 → 到点 abort 本轮（60s 先提示，120s 才杀）
//   · 工具：可能合法长跑 12 分钟（bash 一个构建就够）→ **只提示，永不杀**
//   · compact / ask / 整轮墙钟：只提示（前者的寿命规则在 ask.ts，后者给人自己按停）
//
// 为什么必须区分"首字节"和"流中静默"：慢模型 90s 才吐第一个字节是常事（首字节阈值宽一些、
// 且先只提示），而流已经开始吐字后突然静默 120s，几乎一定是网关卡住 / 连接半死。

import type { AgentEvent, ProgressStage } from './types';

export interface ProgressPolicy {
    /** 模型连上了但一个字节都没吐：到这个点先在 UI 上提示（不杀） */
    firstByteMs: number;
    /** 模型流多久没动就判失联并 abort 本轮（首字节前后同一阈值，但首字节前多一条早提示） */
    streamSilenceMs: number;
    /** 工具多久没心跳只提示（**不杀**：工具可能合法长跑） */
    toolSilenceMs: number;
    /** 压缩多久没回只提示 */
    compactMs: number;
    /** 整轮墙钟到这个点只提示（防"每一步都在动、但永远不停"） */
    turnWallMs: number;
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
    firstByteMs: 60_000,
    streamSilenceMs: 120_000,
    toolSilenceMs: 300_000,
    compactMs: 300_000,
    turnWallMs: 1_800_000,
};

/**
 * 此刻挂着的一个 await（栈：`tool.completed` 之后回到 `model-stream`）。
 *
 * 注意 `heartbeat` 的语义是"**活的证据**"，不是"最后一次碰过"：bash 还在吐输出、
 * 模型还在吐字都算；工具静静跑了 12 分钟没有输出**不算**（但也只提示，见 policy）。
 */
export interface Pending {
    /** 机器读短语：`model-stream` / `tool:<name>` / `ask` / `compact` */
    what: string;
    enteredAt: number;
    /** 这个 await 有没有活的证据 */
    heartbeat: { at: number; from: 'stream' | 'tool-output' } | null;
    /** 内部的精确配对（toolCallId）：同名工具并发时靠它拔对那一根 */
    ref?: string;
}

export interface TurnProgress {
    turnId: string;
    /** 开跑时刻：答"整轮墙钟" */
    startedAt: number;
    /** 最后一刻有进展的时刻：**模型流的唯一 stall 判据** */
    lastProgressAt: number;
    /** 本轮是否已有过内容事件（有 = 已过首字节，首字节提示不再适用） */
    sawContent: boolean;
    /** 此刻挂着的 await */
    pending: Pending[];
}

/**
 * 一次判定的结论（`warn` 自带去重，调用方可以每 5s 调一次 `evaluate()`）。
 *
 * `abort` 只由模型流产出 —— 这是本文件唯一"能动手"的结论，其余全是提示。
 */
export type ProgressVerdict =
    | { action: 'wait' }
    | { action: 'warn'; awaiting: string; idleMs: number; note: string }
    | { action: 'abort'; awaiting: string; idleMs: number; note: string };

/**
 * 此刻的对外事实（= `progress` 事件的内容）。
 *
 * 为什么不用 `ProgressVerdict`：verdict 是「该动手了吗」的判断（wait/warn/abort，
 * 自带去重），而 UI 要的是「现在卡在哪、多久没动」这个可每秒自走的数 —— 每 5s
 * 都会变（idleMs 在涨），不能被 warnOnce 去重掉。
 */
export interface ProgressFact {
    awaiting: string;
    idleMs: number;
    alive: boolean;
}

/**
 * 按 awaiting 选阈值分档（`ProgressStage` 本身在 protocol：UI 要读它定样式）。
 * 工具只到 `slow`：它可能合法长跑，永远不报 stalled。
 */
export function stageOf(
    fact: { awaiting: string; idleMs: number },
    policy: ProgressPolicy = DEFAULT_PROGRESS_POLICY,
): ProgressStage {
    if (fact.awaiting === 'model-stream') {
        if (fact.idleMs >= policy.streamSilenceMs) return 'stalled';
        if (fact.idleMs >= policy.firstByteMs) return 'slow';
        return 'quiet';
    }
    if (fact.awaiting.startsWith('tool:') && fact.idleMs >= policy.toolSilenceMs) return 'slow';
    if (fact.awaiting === 'compact' && fact.idleMs >= policy.compactMs) return 'slow';
    return 'quiet';
}

export interface ProgressWatchOptions {
    policy?: Partial<ProgressPolicy>;
    /** 注入时钟：测试用假 clock，生产用 `Date.now` */
    now?: () => number;
}

/** 一个 running turn 的进展账本（房间级、内存、不落库：重启即失忆是已知边界） */
export class ProgressWatch {
    private readonly policy: ProgressPolicy;
    private readonly now: () => number;
    private readonly warned = new Set<string>();
    private state: TurnProgress | null = null;

    constructor(options: ProgressWatchOptions = {}) {
        this.policy = { ...DEFAULT_PROGRESS_POLICY, ...options.policy };
        this.now = options.now ?? Date.now;
    }

    start(turnId: string): TurnProgress {
        const at = this.now();
        const state: TurnProgress = {
            turnId,
            startedAt: at,
            lastProgressAt: at,
            sawContent: false,
            pending: [{ what: 'model-stream', enteredAt: at, heartbeat: null }],
        };
        this.state = state;
        this.warned.clear();
        return state;
    }

    /**
     * 喂一个运行事件（测试里直接脚本化事件流，不需要真等 120 秒）。
     *
     * 续期规则：任何**内容**事件都算进展；`run.started` 不算（它只说明开了跑）。
     */
    apply(event: AgentEvent): void {
        const state = this.state;
        if (state === null) return;
        const at = this.now();
        switch (event.type) {
            case 'text.delta':
            case 'reasoning.delta':
                state.sawContent = true;
                state.lastProgressAt = at;
                this.markHeartbeat('model-stream', at, 'stream');
                return;
            case 'tool.started':
                this.removePending((pending) => pending.what === 'model-stream');
                state.pending.push({
                    what: `tool:${event.name}`,
                    enteredAt: at,
                    heartbeat: null,
                    ref: event.toolCallId,
                });
                return;
            case 'tool.completed': {
                // 同名工具并发时按 toolCallId 拔那一根；对不上再按名字拔
                const removed = this.removePending((pending) => pending.ref === event.toolCallId);
                if (removed === false) this.removePending((pending) => pending.what === `tool:${event.name}`);
                // 工具回来了 ⇒ 下一步又要等模型
                if (!state.pending.some((pending) => pending.what === 'model-stream')) {
                    state.pending.push({ what: 'model-stream', enteredAt: at, heartbeat: null });
                }
                return;
            }
            case 'run.finished':
            case 'run.failed':
                // 收尾中：不再判 stall（收尾自己的判据在 end-reason.ts）
                state.pending.length = 0;
                return;
            default:
                return;
        }
    }

    /**
     * 二级心跳：长工具每有一点输出就调一次（job 的 tail 变了 / 子进程还在吐）。
     *
     * **不接心跳也不会误杀**（工具阈值只提示），接上则"有进展 3s 前"能显示出来 ——
     * 这是 demo 场景②（12 分钟的 bash 不能被当成卡死）的关键。
     */
    beat(what: string, from: 'stream' | 'tool-output'): void {
        const state = this.state;
        if (state === null) return;
        const at = this.now();
        if (from === 'stream') {
            state.sawContent = true;
            state.lastProgressAt = at;
        }
        this.markHeartbeat(what, at, from);
    }

    /** 手动压一次（compact 开始时调用）；结束时 `settle('compact')` 回到 model-stream */
    enter(what: string): void {
        const state = this.state;
        if (state === null) return;
        const at = this.now();
        state.pending.push({ what, enteredAt: at, heartbeat: null });
    }

    settle(what: string): void {
        const state = this.state;
        if (state === null) return;
        this.removePending((pending) => pending.what === what);
        const at = this.now();
        if (!state.pending.some((pending) => pending.what === 'model-stream')) {
            state.pending.push({ what: 'model-stream', enteredAt: at, heartbeat: null });
        }
    }

    /**
     * 判一次。调用方按固定节奏（5s）调即可 —— `warn` 对同一 (awaiting, note) 只出一次。
     */
    evaluate(): ProgressVerdict {
        const state = this.state;
        if (state === null) return { action: 'wait' };
        const at = this.now();

        // 整轮墙钟：只提示，不杀（"每一步都在动"不该被 watchdog 掐掉）
        const wall = at - state.startedAt;
        if (wall >= this.policy.turnWallMs) {
            return this.warnOnce('turn-wall', 'turn', wall, 'turn-wall');
        }

        const pending = state.pending[state.pending.length - 1];
        if (pending === undefined) return { action: 'wait' };

        if (pending.what === 'model-stream') {
            // 首字节前从开跑算，之后从最后一次进展算
            const idle = at - Math.max(pending.enteredAt, state.lastProgressAt);
            if (idle >= this.policy.streamSilenceMs) {
                return {
                    action: 'abort',
                    awaiting: 'model-stream',
                    idleMs: idle,
                    note: state.sawContent ? 'stream-silent' : 'no-first-byte',
                };
            }
            if (idle >= this.policy.firstByteMs) {
                return this.warnOnce('first-byte', 'model-stream', idle, 'no-first-byte');
            }
            return { action: 'wait' };
        }

        if (pending.what.startsWith('tool:')) {
            // 有活的证据 ⇒ 永不报警（12 分钟的 bash 也是健康的）
            if (pending.heartbeat !== null) return { action: 'wait' };
            const idle = at - pending.enteredAt;
            if (idle >= this.policy.toolSilenceMs) {
                return this.warnOnce(`${pending.what}:silent`, pending.what, idle, 'tool-silent');
            }
            return { action: 'wait' };
        }

        if (pending.what === 'compact') {
            const idle = at - pending.enteredAt;
            if (idle >= this.policy.compactMs) {
                return this.warnOnce('compact:slow', 'compact', idle, 'compact-slow');
            }
            return { action: 'wait' };
        }

        // ask 的寿命规则在 ask.ts（它有自己的过期判定），这里不重复
        return { action: 'wait' };
    }

    /**
     * 此刻的对外事实（`progress` 事件用）。与 `stall()` 的区别：那个是收尾时的「停在哪」（
     * 只在 abort 那一刻问一次），这个是每 tick 都要的「还在动吗」（带 `alive`）。
     */
    fact(): ProgressFact | undefined {
        const state = this.state;
        if (state === null) return undefined;
        const pending = state.pending[state.pending.length - 1];
        if (pending === undefined) return undefined;
        const at = this.now();
        // 有心跳就从心跳算（「有进展 3s 前」必须是 3s，不能是「挂上这个 await 那一刻」）
        const from =
            pending.what === 'model-stream'
                ? Math.max(pending.enteredAt, state.lastProgressAt)
                : (pending.heartbeat?.at ?? pending.enteredAt);
        return { awaiting: pending.what, idleMs: at - from, alive: pending.heartbeat !== null };
    }

    /**
     * 收尾前问一句"停在哪"：给 `endReasonOf` 的 `stall` 字段用。
     *
     * 不看阈值 —— 它只回答事实（在等谁 / 空了多久），该不该算 stall 由调用方决定。
     */
    stall(): { awaiting: string; idleMs: number } | undefined {
        const state = this.state;
        if (state === null) return undefined;
        const pending = state.pending[state.pending.length - 1];
        if (pending === undefined) return undefined;
        const at = this.now();
        const from =
            pending.what === 'model-stream'
                ? Math.max(pending.enteredAt, state.lastProgressAt)
                : (pending.heartbeat?.at ?? pending.enteredAt);
        return { awaiting: pending.what, idleMs: at - from };
    }

    /** 只读快照（诊断面 / 测试用；调用方不得改它） */
    snapshot(): TurnProgress | null {
        return this.state;
    }

    reset(): void {
        this.state = null;
        this.warned.clear();
    }

    private markHeartbeat(what: string, at: number, from: 'stream' | 'tool-output'): void {
        const state = this.state;
        if (state === null) return;
        for (const pending of state.pending) {
            if (pending.what === what) pending.heartbeat = { at, from };
        }
    }

    /** 拔掉匹配的 pending（返回是否真的拔掉了） */
    private removePending(match: (pending: Pending) => boolean): boolean {
        const state = this.state;
        if (state === null) return false;
        const index = state.pending.findIndex(match);
        if (index < 0) return false;
        state.pending.splice(index, 1);
        return true;
    }

    private warnOnce(key: string, awaiting: string, idleMs: number, note: string): ProgressVerdict {
        if (this.warned.has(key)) return { action: 'wait' };
        this.warned.add(key);
        return { action: 'warn', awaiting, idleMs, note };
    }
}

/**
 * `progress` 事件的节流：**只在事实变了时发一条**。
 *
 * 为什么不是每隔几秒打一条心跳：idleMs 是单调时间，客户端拿最后一条自走就能算出
 * 当前秒数 —— 持续打点只会把「每 5s 一次的界面重渲」白送给所有订阅者。
 * 三种变化值得发：换了一个 await（`awaiting`）、心跳有无翻转（`alive`）、跨了阈值档（`stage`）。
 *
 * 「最多每 5s 一条」由调用方的 tick 周期保证（session 里 `progressTickMs`）。
 */
export class ProgressBroadcast {
    private readonly policy: ProgressPolicy;
    private last: { awaiting: string; alive: boolean; stage: ProgressStage } | null = null;
    private lastAt: number | null = null;

    constructor(policy: Partial<ProgressPolicy> = {}) {
        this.policy = { ...DEFAULT_PROGRESS_POLICY, ...policy };
    }

    /** 该发就返回这一条的 `stage`（调用方直接放进事件），不该发返回 null */
    shouldSend(fact: ProgressFact, now: number = Date.now()): ProgressStage | null {
        const stage = stageOf(fact, this.policy);
        const last = this.last;
        const changed =
            last === null || last.awaiting !== fact.awaiting || last.alive !== fact.alive || last.stage !== stage;
        // 有心跳时定期刷新一次基准：否则 UI 的「有进展 Ns 前」会跟着本地时钟一路涨
        //（事件只在 alive 翻转时发的话，持续输出的工具看起来像在变慢）
        const refreshAlive = fact.alive && this.lastAt !== null && now - this.lastAt >= 5_000;
        this.last = { awaiting: fact.awaiting, alive: fact.alive, stage };
        if (!changed && !refreshAlive) return null;
        this.lastAt = now;
        return stage;
    }
}
