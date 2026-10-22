// src/main/services/spawned-jobs.ts
// 🎯 spawned job 的**生命周期 + 记账 + 采样**（##408 刀 5）。
//
// 消费者是 bash 工具：一条命令跑过 `SPAWN_JOB_PROMOTE_MS`（10s）就算一条 job，
// 期间它的输出进输出环（`shared/output-ring.ts`）、有 IO 的地方都注入（可单测）。
//
// ── 三条设计决定（都不显然，别顺手改）──
//
// ① **采样是「拉」的，不起定时器**
//    每个 `top -l 2` 采样要 ~1s 阻塞（见 `process-sampler.ts` 头注）；给每个后台命令
//    常驻采样 = 让 agent 自己把机器拖慢。所以采样只发生在**有人看的时候**：
//    CLI `job ls --live` / `job show <id>`（将来的面板同理）调 `sampleNow()`。
//    代价如实记账：没人看 ⇒ `samples: 0`，汇总文案写「未采样（无人查看）」，**不编造健康**。
//    顺带解决了「不引入 `setInterval`」这条本刀硬约束（调度器属 v2）。
//
// ② **晋升（落账）是惰性的**：只在「下一个自然事件」上判（来输出 / 有人采样 / 收口）。
//    于是「无输出且没人看」的长命令只在**跑完时**才出现在账上 —— 这是 ① 的必然代价，
//    已在 `shared/spawned-job.ts` 头注写明。`live()` 里它仍然可见（`promoted: false`）。
//
// ③ **账本只收长时命令**：短命令（< 10s）不落账、不落日志、不占 `$DIY_HOME/jobs/`。
//    判据唯一真源是 `shouldTrackAsJob()`；这里不另写阈值。

import { join } from "node:path";
import { readRuntimeConfig } from "../../runtime";
import {
    assertOrigin,
    settleRun,
    type JobOrigin,
    type JobRun,
} from "../../shared/job-run";
import {
    appendRunOutput,
    freezeRunOutput,
    tailOfRing,
    createRunOutput,
    type RunOutput,
} from "../../shared/output-ring";
import {
    DEFAULT_HEALTH_POLICY,
    judgeHealth,
    type HealthVerdict,
    type ProcessSample,
} from "../../shared/process-health";
import { sampleProcess, type SampleInput } from "./process-sampler";
import { writeFileAtomic } from "../core/atomic-write";
import { appendRun, jobsDir } from "./job-ledger";
import {
    buildRunSummary,
    jobIdOfTaskCommand,
    jobTitleOf,
    makeRunId,
    outcomeState,
    shouldTrackAsJob,
    summarizeRunHealth,
    type RunHealthSummary,
    type RunOutcome,
} from "../../shared/spawned-job";

/**
 * 由入参构造 origin —— **硬约束 1 的第一道闸**（entry 处就校验，不留到落账时）。
 *
 * 为什么要提前：这事儿的缺陷属于「调用点忘了传锚点」，晚到 `promote()` 才抛的话，
 * 命令可能已经跑了几分钟（白跑），而且缺陷发生在异步路径上、难以归因到调用点。
 */
export function originOf(input: BeginSpawnedInput): JobOrigin {
    return assertOrigin(
        {
            type: "spawned",
            data: {
                taskUri: input.taskUri,
                turnId: input.turnId,
                stepId: input.stepId,
                toolCallId: input.toolCallId,
                cmd: input.cmd,
            },
        },
        "spawned-jobs.begin",
    );
}

/** settle 快照落盘目录：`$DIY_HOME/jobs/logs/`（与账本同根，便于一起清理）。 */
export function jobLogsDir(home: string = readRuntimeConfig().home): string {
    return join(jobsDir(home), "logs");
}

export function jobLogPath(runId: string, home: string = readRuntimeConfig().home): string {
    return join(jobLogsDir(home), `${runId}.log`);
}

/** 注入点（测试全用它；生产用缺省实现）。 */
export interface SpawnedJobDeps {
    readonly home?: string;
    now(): number;
    rand(): number;
    /** 落一行账（缺省 `job-ledger.appendRun`） */
    appendRun(run: JobRun, opts?: { home?: string; now?: number }): Promise<JobRun>;
    /** 采一份现场（缺省 `process-sampler.sampleProcess`，会真跑 ps/top/lsof） */
    sample(input: SampleInput): ProcessSample;
    /**
     * 写文件（缺省**原子写** `core/atomic-write.ts`）。
     *
     * 为什么必须原子：settle 快照会被 `job show` 随时读，写一半被读到 = 半个字符 / 半截日志。
     * 原子写顺带把「父目录不存在」也解决了（内部 mkdir recursive）。
     */
    // non-atomic-ok: 注入点声明；缺省实现是 writeFileAtomic（原子），测试注入临时实现
    writeFile(path: string, data: string): Promise<void>;
}

export const DEFAULT_SPAWNED_DEPS: SpawnedJobDeps = {
    now: () => Date.now(),
    rand: () => Math.random(),
    appendRun: (run, opts) => appendRun(run, opts),
    sample: (input) => sampleProcess(input),
    writeFile: async (path, data) => {
        writeFileAtomic(path, data);
    },
};

/** 发起一条 spawned run 的入参（origin 的三段锚点 + 实参）。 */
export interface BeginSpawnedInput {
    readonly taskUri: string;
    readonly turnId: string;
    readonly stepId: string;
    readonly toolCallId: string;
    /** 实际执行的命令（origin 里也是这一份 —— 它是实参，不是上下文快照） */
    readonly cmd: string;
    readonly cwd: string;
}

/** 收口入参：**怎么结束的**由调用点从 runBash 的判定结果映射过来。 */
export interface FinishSpawnedInput {
    readonly outcome: RunOutcome;
    readonly exitCode?: number;
    readonly signal?: string;
    /** 失败侧的可读原因（spawn 失败 / 超时 / 输出溢出 等） */
    readonly error?: string;
}

export interface LiveSample {
    readonly at: number;
    readonly verdict: HealthVerdict;
    readonly reason: string;
    readonly cpuPercent: number;
    readonly treeCpuPercent: number;
    readonly memoryRssKb: number | null;
    readonly childCount: number;
}

/** `live()` / `snapshot()` 的视图：**只读投影**，不暴露 handle 的可变状态。 */
export interface LiveRunView {
    readonly runId: string;
    readonly jobId: string;
    readonly title: string;
    readonly taskUri: string;
    readonly origin: JobOrigin;
    readonly startedAt: string;
    readonly runMs: number;
    /** 已经落过 `running` 行（> 10s 且有过自然事件） */
    readonly promoted: boolean;
    readonly pid: number | null;
    readonly output: {
        readonly capBytes: number;
        readonly bytes: number;
        readonly totalBytes: number;
        readonly droppedBytes: number;
    };
    readonly samples: number;
    readonly lastSample: LiveSample | null;
}

export interface FinishResult {
    /** 收口后的 run（无论是否落账都给，调用点可据此写审计） */
    readonly run: JobRun;
    /** 是否写进了执行账（短命令 = false） */
    readonly persisted: boolean;
    readonly health: RunHealthSummary;
}

/**
 * 一次 spawned run 的**句柄**：bash 工具拿它喂输出、采样、收口。
 *
 * 为什么是句柄不是「一堆自由函数」：一次 run 的可变状态（环、样本、是否已晋升）
 * 必须只有一份；散成模块级 Map + 参数 = 重复构造、状态漂移。
 */
export class SpawnedJobHandle {
    private readonly startedMs: number;
    private runOutput: RunOutput = createRunOutput();
    private readonly samples: ProcessSample[] = [];
    private lastSample: LiveSample | null = null;
    private lastOutputAt: number | null = null;
    private outputBytes = 0;
    private pid: number | null = null;
    private promoted = false;
    private promotion: Promise<void> | null = null;
    private finished: FinishResult | null = null;

    constructor(
        private readonly deps: SpawnedJobDeps,
        private readonly input: BeginSpawnedInput,
        readonly id: string,
        readonly jobId: string,
        private readonly title: string,
    ) {
        this.startedMs = deps.now();
    }

    /** 子进程起来了才知道 pid（采样 / 诊断都需要它）。 */
    setPid(pid: number): void {
        this.pid = pid;
    }

    /**
     * 喂一块输出（stdout / stderr 都算，按到达顺序）。
     *
     * 为什么到收口才判晋升：见文件头 ② —— 事件驱动的惰性晋升，不需要定时器。
     */
    noteOutput(chunk: Uint8Array): void {
        if (chunk.length === 0) return;
        this.outputBytes += chunk.length;
        this.lastOutputAt = this.deps.now();
        // 环是只读快照语义（appendRunOutput 返回新对象），这里存回字段
        this.runOutput = appendRunOutput(this.runOutput, chunk);
        void this.promoteIfDue();
    }

    /**
     * 等「晋升落账」这条异步链走完（CLI 立刻要读账时用；正常路径不需要 —— `finish()` 内含等待）。
     */
    async flush(): Promise<void> {
        await (this.promotion ?? Promise.resolve());
    }

    /** 已运行多长（ms）。 */
    runMs(): number {
        return Math.max(0, this.deps.now() - this.startedMs);
    }

    /**
     * 采一份现场（**拉**语义：调用点 = 有人要看）。
     *
     * 采不到（没 pid / 采样器返回全 0）也算采过一次 —— `judgeHealth` 会走 R6 不下结论，
     * 比「假装健康」诚实。采样本身不抛（sampler 内部已吞掉所有失败）。
     */
    sampleNow(): LiveSample | null {
        void this.promoteIfDue();
        if (this.pid === null || this.pid <= 0) return null;
        const sample = this.deps.sample({
            pid: this.pid,
            command: this.input.cmd,
            outputBytes: this.outputBytes,
            lastOutputAt: this.lastOutputAt,
            historicalP50Ms: null, // 历史 p50 要有「同命令历史」才有意义，属 v2 的账本统计
        });
        this.samples.push(sample);
        const d = judgeHealth(sample, DEFAULT_HEALTH_POLICY);
        this.lastSample = {
            at: this.deps.now(),
            verdict: d.verdict,
            reason: d.reason,
            cpuPercent: sample.cpuPercent,
            treeCpuPercent: sample.treeCpuPercent ?? sample.cpuPercent,
            memoryRssKb: sample.memoryRssKb ?? null,
            childCount: sample.childCount,
        };
        return this.lastSample;
    }

    /** 只读视图（不采样 —— 列表页每秒刷新不该每次都跑 top）。 */
    snapshot(): LiveRunView {
        return {
            runId: this.id,
            jobId: this.jobId,
            title: this.title,
            taskUri: this.input.taskUri,
            origin: this.origin(),
            startedAt: this.startedAtIso(),
            runMs: this.runMs(),
            promoted: this.promoted,
            pid: this.pid,
            output: {
                capBytes: this.runOutput.live.capBytes,
                bytes: this.runOutput.live.bytes.length,
                totalBytes: this.runOutput.live.totalBytes,
                droppedBytes: this.runOutput.live.droppedBytes,
            },
            samples: this.samples.length,
            lastSample: this.lastSample,
        };
    }

    /** 当前 live 环与 settle 环的**文本**（CLI `job show` 用；settle 未收口时为空串）。 */
    outputSnapshot(): { live: string; settle: string; frozen: boolean } {
        const dec = new TextDecoder("utf-8");
        return {
            live: dec.decode(this.runOutput.live.bytes),
            settle: dec.decode(this.runOutput.settle.bytes),
            frozen: this.runOutput.frozen,
        };
    }

    /**
     * 收口：补终态、写 settle 日志、落账。
     *
     * 幂等：重复调用返回第一次的结果（bash 侧有「用户取消」与「close 事件」两条到达路径，
     * 两条都可能走到这里 —— 不允许写两行终态）。
     */
    async finish(input: FinishSpawnedInput): Promise<FinishResult> {
        if (this.finished) return this.finished;
        const endedMs = this.deps.now();
        const endedAt = new Date(endedMs).toISOString();
        const ms = Math.max(0, endedMs - this.startedMs);
        // 收口前补一次晋升判定：无输出、没人看的短命令不该凭空进账
        const persist = this.promoted || shouldTrackAsJob(ms);
        const health = summarizeRunHealth(this.samples);

        let logPath: string | undefined;
        if (persist) {
            // settle 快照 = live 的尾 16KB（冻结后不再被后续 chunk 改写；此处 run 已结束，固本来也不会再变）
            this.runOutput = freezeRunOutput(this.runOutput);
            logPath = this.logPath();
            try {
                const tail = new TextDecoder("utf-8").decode(tailOfRing(this.runOutput.live, this.runOutput.settle.capBytes).bytes);
                // non-atomic-ok: 走注入点；缺省实现 writeFileAtomic（原子），见 SpawnedJobDeps.writeFile
                await this.deps.writeFile(logPath, tail);
            } catch (e) {
                // 写日志失败**不许**让收口失败：账是主，日志是辅
                logPath = undefined;
                console.warn(`[spawned-jobs] 写 settle 日志失败 ${this.id}:`, e);
            }
            await this.ensurePromoted();
        }

        const running: JobRun = this.runningRun();
        const settled = settleRun(running, {
            state: outcomeState(input.outcome) as Exclude<JobRun["state"], "running">,
            endedAt,
            outcome: input.outcome,
            ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
            summary: buildRunSummary({
                outcome: input.outcome,
                ms,
                ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
                outputBytes: this.outputBytes,
                droppedBytes: this.runOutput.live.droppedBytes,
                health,
            }),
            ...(input.error !== undefined ? { error: input.error } : {}),
            ...(logPath !== undefined ? { logPath } : {}),
        });

        if (persist) {
            try {
                await this.deps.appendRun(settled, { home: this.deps.home });
            } catch (e) {
                // 账写不进去是**观测**故障，不许冒到 bash（命令已经跑完了，用户不该因为记账失败收不到结果）
                console.warn(`[spawned-jobs] 落账失败 ${this.id}:`, e);
            }
        }
        this.finished = { run: settled, persisted: persist, health };
        return this.finished;
    }

    // ── 内部 ──

    /** origin 在 `begin()` 时已校验过（见 `originOf`），这里只是取那份规范化的结果。 */
    private origin(): JobOrigin {
        return originOf(this.input);
    }

    private startedAtIso(): string {
        return new Date(this.startedMs).toISOString();
    }

    private logPath(): string {
        return jobLogPath(this.id, this.deps.home ?? readRuntimeConfig().home);
    }

    private runningRun(): JobRun {
        return {
            id: this.id,
            jobId: this.jobId,
            kind: "spawned",
            title: this.title,
            owner: { type: "turn", taskUri: this.input.taskUri, turnId: this.input.turnId },
            state: "running",
            startedAt: this.startedAtIso(),
            origin: this.origin(),
        };
    }

    /** 达到阈值就写 `running` 行（只写一次；并发调用共用同一个 promise）。 */
    private promoteIfDue(): Promise<void> {
        if (this.promoted || !shouldTrackAsJob(this.runMs())) return Promise.resolve();
        return this.ensurePromoted();
    }

    private ensurePromoted(): Promise<void> {
        if (this.promoted) return this.promotion ?? Promise.resolve();
        this.promoted = true;
        const run = this.runningRun();
        const p = this.deps
            .appendRun(run, { home: this.deps.home })
            .then(() => {})
            .catch((e: unknown) => {
                // 首行写不进去 ⇒ 后面的终态也不要写了（写了就是无头账），但要留痕
                this.promoted = false;
                console.warn(`[spawned-jobs] 写 running 行失败 ${this.id}:`, e);
            });
        this.promotion = p;
        return p;
    }
}

/**
 * 全部在跑的 spawned job（进程内单例；CLI / 面板 / 诊断出口共用这一份）。
 *
 * ⚠️ 这是**易变量**：进程重启即清空（重启恢复 = 把盘上 `running` 判成 `lost`，属下一刀）。
 */
export class SpawnedJobTracker {
    private readonly live_ = new Map<string, SpawnedJobHandle>();
    private readonly history: SpawnedJobHandle[] = [];

    constructor(private readonly deps: SpawnedJobDeps = DEFAULT_SPAWNED_DEPS) {}

    /** 起一条 run（bash 工具在**开始执行**时调用；是否落账由阈值决定，见文件头 ②③）。 */
    begin(input: BeginSpawnedInput): SpawnedJobHandle {
        originOf(input); // 入口即校验：缺锚点的调用点当场失败，而不是跑到收口才炸
        const now = this.deps.now();
        const runId = makeRunId(now, this.deps.rand);
        const jobId = jobIdOfTaskCommand(input.taskUri, input.cwd, input.cmd);
        const handle = new SpawnedJobHandle(this.deps, input, runId, jobId, jobTitleOf(input.cmd));
        this.live_.set(runId, handle);
        return handle;
    }

    /** 收口后从 live 摘掉（保留在 `history` 里，供「刚跑完」的 CLI 视图）。 */
    noteFinished(handle: SpawnedJobHandle): void {
        this.live_.delete(handle.id);
        this.history.push(handle);
        if (this.history.length > 20) this.history.shift();
    }

    /** 正在跑的全部（含未晋升的）。 */
    live(): LiveRunView[] {
        return [...this.live_.values()].map((h) => h.snapshot());
    }

    get(runId: string): SpawnedJobHandle | null {
        return this.live_.get(runId) ?? this.history.find((h) => h.id === runId) ?? null;
    }

    /** 进程内可见的 run 数（诊断 / 测试用）。 */
    size(): number {
        return this.live_.size;
    }

    /** 只清内存（测试用；不碰盘）。 */
    clear(): void {
        this.live_.clear();
        this.history.length = 0;
    }
}

/** 生产单例：bash 工具写入、RPC 读。 */
export const spawnedJobs = new SpawnedJobTracker();

/** 供 `job ls` 用：没有活任务时返回空数组（不是错误）。 */
export function liveSpawnedJobs(): LiveRunView[] {
    return spawnedJobs.live();
}

export type { RunOutcome, RunHealthSummary };
