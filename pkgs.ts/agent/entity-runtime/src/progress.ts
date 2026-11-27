// progress.ts —— 「这一轮还活着吗」的判据 + 对外事实（session 用；假 clock 可直测）。
//
// 存在的理由：`runTurn` 的 for-await 只有在 SDK 肯退出时才会走到 finally ——
// 网关连上不吐字节、流中途静默时，`endReasonOf` 再完美也**永远没机会跑**，
// 用户看到的是"一直转圈"；关掉再打开还是转圈，因为卡住的调用没人管。
//
// ## 本文件**只说不杀**
//
// 2026-11-25 裁：**中止权只有一个主人，就是 `stall-watchdog.ts` 的 StallWatchdog**
// （它在 agent 层，是「读流的人」：`touch()` 挂在每个 part 上，事实零延迟零失真；
// 本文件是从 AgentEvent **反推**出来的，agent 内部的 retry / 空 chunk / provider 内部重连
// 它都看不见）。两边都能杀的时候，同一个 120s 会产出两种结局（`stalled` / `error`），
// 而且谁先响定时器决定用户看到哪一条 —— 「同一故障两种说法」就是这么来的。
//
// 分工（一个 await 只能有一个所有者）：
//   · 模型流（首包 / 块间）→ **StallWatchdog 独占**：唯一判、唯一杀。本文件只按它的
//     斩杀线**派生**提示档（见 `DEFAULT_PROGRESS_POLICY`），负责「让人早点看见」。
//   · 工具 / compact / 整轮墙钟 → **本文件独占**：这三样 agent 层看不见（它不跑 compact、
//     不知道 turn 何时开、看不到 ask 的寿命），所以由 session 判，且**一律只提示**。
//
// ## 过程不许进历史（用户 2026-11-24）
//
// 本文件产出的是**事实**（在等谁 / 空了多久 / 有没有活的证据），它只走 ephemeral 的
// `progress` 事件：刷新即失，合理 —— 下一秒 tick 又会把它刷回来（轮次还在跑）。
// 以前这里还派生出「该提醒了吧」的 verdict，再被 session 翻成一条 notice **落进永久历史**，
// 于是“61 秒还没吐出第一个字”“44 秒没有新内容”这种东西一天天堆在时间线里。
// verdict / progressNotice 已删：**过程不上墙，只有结局（stalled / error / 预算用完）才落盘**。
//
// 与 `end-reason.ts` 同样的两条纪律：
//   1. **判据只在这一个文件**（不 import agent / db / room）：UI、room、测试共用一份
//   2. **只说事实**：`what`（在等谁）/ `idleMs`（多久没动）/ `alive`（有没有活的证据）；
//      人话（“再等就中止”）只在真出事时由 `end-reason.ts` 的 `endItemsOf` 说
//
// 为什么必须区分"首字节"和"流中静默"：慢模型 90s 才吐第一个字节是常事（首字节阈值宽一些），
// 而流已经开始吐字后突然静默，几乎一定是网关卡住 / 连接半死。

import type { AgentEvent, ProgressStage } from './types';
import { DEFAULT_STALL } from './stall-watchdog';

/**
 * 模型流那四档阈值**从 StallWatchdog 的斩杀线派生**，不另写死数。
 *
 * 为什么必须派生：提示档如果贴着斩杀线（都一样是 120s），提示发出去之前那一轮已经死了 ——
 * `RunningIndicator` 的第三档在「流中静默」场景里**永远看不到**（提示窗口为零）。
 * 改成斩杀线的 1/3 提示、2/3 报 stalled，就必然留出窗口；改 StallWatchdog 的时长，
 * 这里跟着动，两个数不会再漂。
 *
 * 已知边界：`DIY2_LLM_STALL_*` 改了 env 时本文件不知道（它只从 `DEFAULT_STALL` 派生）。
 * 代价只是提示档位不准，**不影响中止**（中止在 agent 层按 env 走）。
 */
const WARN_RATIO = 1 / 3;
const STALLED_RATIO = 2 / 3;

/** 斩杀线 → 提示档；斩杀关掉（0）时提示也关掉 */
function warnAt(killMs: number): number {
    return killMs > 0 ? Math.round(killMs * WARN_RATIO) : Number.POSITIVE_INFINITY;
}

function stalledAt(killMs: number): number {
    return killMs > 0 ? Math.round(killMs * STALLED_RATIO) : Number.POSITIVE_INFINITY;
}

export interface ProgressPolicy {
    /** 首字节前多久先提示（派生自 `StallWatchdog.firstMs`，**不杀**） */
    firstByteWarnMs: number;
    /** 首字节前多久报 `stalled` 档（派生；真正的杀在 StallWatchdog） */
    firstByteStalledMs: number;
    /** 吐过字之后多久没新内容先提示（派生自 `StallWatchdog.idleMs`） */
    streamWarnMs: number;
    /** 吐过字之后多久没新内容报 `stalled` 档（派生；真正的杀在 StallWatchdog） */
    streamStalledMs: number;
    /** 工具多久没心跳算 `slow` 档（**不杀**：工具可能合法长跑；这个 agent 层看不见） */
    toolSilenceMs: number;
    /** 压缩多久没回算 `slow` 档 */
    compactMs: number;
}

/**
 * 斩杀线 → 模型流那四档（导出的原因：将来要按 env 的 `stallTimeoutsFromEnv()` 派生时，
 * 调用方复用这一个函数就行；测试也直接验它，不去抄数）。
 */
export function progressPolicyFromStall(stall: {
    firstMs: number;
    idleMs: number;
}): Pick<ProgressPolicy, 'firstByteWarnMs' | 'firstByteStalledMs' | 'streamWarnMs' | 'streamStalledMs'> {
    return {
        firstByteWarnMs: warnAt(stall.firstMs),
        firstByteStalledMs: stalledAt(stall.firstMs),
        streamWarnMs: warnAt(stall.idleMs),
        streamStalledMs: stalledAt(stall.idleMs),
    };
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
    ...progressPolicyFromStall(DEFAULT_STALL),
    toolSilenceMs: 300_000,
    compactMs: 300_000,
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
 * 此刻的对外事实（= `progress` 事件的内容）。
 *
 * UI 要的是「现在卡在哪、多久没动」这个可每秒自走的数 —— 每 5s 都会变（idleMs 在涨），
 * 不能被"同一种提示只出一次"这类去重掉。档位（`stageOf`）也在这一层算好一起发。
 */
export interface ProgressFact {
    awaiting: string;
    idleMs: number;
    alive: boolean;
    /** 本轮吐过字没有：决定模型流按「首字节前」还是「流中」那组阈值分档 */
    sawContent: boolean;
}

/**
 * 按 awaiting 选阈值分档（`ProgressStage` 本身在 protocol：UI 要读它定样式）。
 * 工具只到 `slow`：它可能合法长跑，永远不报 stalled。
 */
export function stageOf(
    fact: { awaiting: string; idleMs: number; sawContent?: boolean },
    policy: ProgressPolicy = DEFAULT_PROGRESS_POLICY,
): ProgressStage {
    if (fact.awaiting === 'model-stream') {
        // 首字节前 / 流中两组的斩杀线不同（180s / 120s），档位也跟着分开
        const firstByte = fact.sawContent !== true;
        const stalledMs = firstByte ? policy.firstByteStalledMs : policy.streamStalledMs;
        const warnMs = firstByte ? policy.firstByteWarnMs : policy.streamWarnMs;
        if (fact.idleMs >= stalledMs) return 'stalled';
        if (fact.idleMs >= warnMs) return 'slow';
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

    /** 此刻的对外事实（`progress` 事件用）：每 tick 都要的「还在动吗」（带 `alive`） */
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
        return {
            awaiting: pending.what,
            idleMs: at - from,
            alive: pending.heartbeat !== null,
            sawContent: state.sawContent,
        };
    }

    /**
     * 此刻的档位 —— **用本 watch 自己的 policy 算**。
     *
     * 存在理由：`stageOf(fact)` 不传 policy 就用默认值，于是「每 bot 可配的阈值」在
     * 调用方漏传时会静默失灵（测试里真踩到了：覆盖了 `firstByteWarnMs: 10`，档位还是 quiet）。
     * 要算档位就调这个，别再自己拿 `fact()` 去拼。
     */
    stage(): ProgressStage | undefined {
        const fact = this.fact();
        return fact === undefined ? undefined : stageOf(fact, this.policy);
    }

    /** 只读快照（诊断面 / 测试用；调用方不得改它） */
    snapshot(): TurnProgress | null {
        return this.state;
    }

    reset(): void {
        this.state = null;
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
