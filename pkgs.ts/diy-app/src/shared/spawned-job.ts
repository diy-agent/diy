/**
 * spawned-job.ts — 会话里跑出来的**长时命令**如何变成一条 job（##408 刀 5；纯函数、零 IO）。
 *
 * 分工：本文件只回答「凭什么算长时 / 怎么结束算哪种结局 / 采样怎么汇总成人话」，
 * 真正的进程、账本、落盘在 `main/services/spawned-jobs.ts`（有 IO、可注入时钟）。
 * 分开的好处：判据全在这里（可单测、可 review），接线在那里（不好测的部分薄）。
 *
 * ── 为什么需要「阈值」这件事（本刀的硬问题）──
 *   bash 工具每敲一条命令就是一整轮工具调用，`ls` / `rg` / `cat` 占绝大多数 ——
 *   全注册成 job，账本与面板当天就被几万条秒级 run 淹掉（用户要的「可见」变成「噪声」）。
 *   所以问题不是「要不要登记」，而是「**凭什么算长时**」。判据必须：
 *     ① 显式常量（不拍脑袋），写在这里并说明为什么是这个数；
 *     ② 与已存在的尺子对齐（别再造一把），能一句话说清「过了它才值得被看见」。
 *
 *   取 **10 秒**，理由三条（都是本仓库里已有的量，不是感觉）：
 *     a) 人类回一次头的耐心约 10s —— 短于它的命令用户根本来不及觉得「卡住」，
 *        工具结果直接带回正文，可见性已经足够（它就在那一轮的工具块里）。
 *     b) `process-health` 的 `progressWindowMs = 15s`：静默 15s 内一律判「在推进」。
 *        在 15s 之前采任何样本都不产生判断价值 ⇒ 登记得再早也只是空账。
 *     c) `top -l 2` 采一次要 ~1s 的阻塞（见 sampler 头注）：只给「可能已经卡住」的
 *        那部分命令采，才有资格谈成本。
 *   现状代价（**如实记下**）：无输出且从不落账的长命令，只在**跑完时**才出现在账上
 *   （`live()` 里仍可见，标 `promoted:false`）。这是「不引入定时器」的必然代价 ——
 *   定时器的活属 v2 调度器，本刀不碰。
 */

import type { JobRunState } from "./job-run";
import {
    DEFAULT_HEALTH_POLICY,
    judgeHealth,
    type HealthPolicy,
    type HealthRule,
    type HealthVerdict,
    type ProcessSample,
} from "./process-health";

/**
 * 长时命令的**晋升阈值**：已运行 ≥ 10s 才算 job（判据与理由见文件头 a/b/c）。
 *
 * 改它必须同时改文件头的三条理由（否则下一次 review 就只剩一个孤零零的数字）。
 */
export const SPAWN_JOB_PROMOTE_MS = 10_000;

/** 已运行这么久 ⇒ 值得登记成 job。 */
export function shouldTrackAsJob(runMs: number): boolean {
    return runMs >= SPAWN_JOB_PROMOTE_MS;
}

// ═══════════════════════════════════════════════
//  结局（outcome）与状态（state）的分工
// ═══════════════════════════════════════════════

/**
 * 一次 run **怎么结束的**（四值）。
 *
 * 与 `JobRunState` 的关系：state 回答「生命周期是否收敛 + 是否成功」（四态，见 `job-run.ts`），
 * outcome 回答「具体怎么收的场」。两件事不能挤进一个字段：
 *   · `canceled`（用户点了停止）在 state 里必须落 `failed`（刀 2 定稿：被信号杀 = failed + signal），
 *     但把它和「命令自己报错」算进同一个失败数，面板的分红就失真了 —— 用户取消不是缺陷。
 *   · `timeout`（被我们 300s 超时杀掉）同理：它不是命令的错，是它「跑太久」。
 * ⇒ outcome 是**给人和统计看的**，state 是**状态机与账本判据用的**；两者由 `OUTCOME_TO_STATE` 固定映射。
 */
export type RunOutcome = "ok" | "fail" | "canceled" | "timeout";

export const RUN_OUTCOMES = ["ok", "fail", "canceled", "timeout"] as const;

/** outcome → state 的唯一映射（别在调用点各写一遍 if）。 */
export const OUTCOME_TO_STATE: Readonly<Record<RunOutcome, JobRunState>> = {
    ok: "settled",
    fail: "failed",
    canceled: "failed",
    timeout: "failed",
};

const OUTCOME_LABEL: Readonly<Record<RunOutcome, string>> = {
    ok: "完成",
    fail: "失败",
    canceled: "已取消",
    timeout: "超时",
};

export function outcomeState(outcome: RunOutcome): JobRunState {
    return OUTCOME_TO_STATE[outcome];
}

export function describeOutcome(outcome: RunOutcome): string {
    return OUTCOME_LABEL[outcome];
}

// ═══════════════════════════════════════════════
//  采样汇总（process-health 的第一个消费者）
// ═══════════════════════════════════════════════

/**
 * 一次 run 期间采到的样本 → 一句结论 + 峰值。
 *
 * **采样是「拉」的**（本刀的设计决定，见 `main/services/spawned-jobs.ts` 头注）：
 * 没有 panel / CLI 在看就不采 —— `top -l 2` 一次 ~1s 阻塞，给每个后台命令常驻采样
 * 是不可接受的成本。所以样本数可能是 0（谁都没看），这时候汇总必须**如实说 0**，
 * 不许编一个「健康」。这正是 `samples === 0 ⇒ verdict null` 的理由。
 */
export interface RunHealthSummary {
    readonly samples: number;
    /** 采到过几次 `stuck`（判据 `judgeHealth`；0 = 从没判过卡住） */
    readonly stuckSamples: number;
    readonly peakCpuPercent: number;
    readonly peakTreeCpuPercent: number;
    /** 峰值常驻内存（KB）；一次都没采到 = 0（调用点据此省略该段文案） */
    readonly peakMemoryKb: number;
    /** 最后一次采样时的大小（子进程 / 输出 / 静默） */
    readonly lastChildCount: number;
    readonly lastOutputBytes: number;
    readonly lastSilentMs: number;
    /** 最后一次采样的判活结论；没采过样 = null */
    readonly lastVerdict: HealthVerdict | null;
    readonly lastRule: HealthRule | null;
    readonly lastReason: string | null;
}

const EMPTY_HEALTH: RunHealthSummary = {
    samples: 0,
    stuckSamples: 0,
    peakCpuPercent: 0,
    peakTreeCpuPercent: 0,
    peakMemoryKb: 0,
    lastChildCount: 0,
    lastOutputBytes: 0,
    lastSilentMs: 0,
    lastVerdict: null,
    lastRule: null,
    lastReason: null,
};

export function emptyHealthSummary(): RunHealthSummary {
    return EMPTY_HEALTH;
}

/** 把若干样本收敛成汇总。判据复用 `judgeHealth`（同一把尺子，不另写一套阈值）。 */
export function summarizeRunHealth(
    samples: readonly ProcessSample[],
    policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): RunHealthSummary {
    if (samples.length === 0) return EMPTY_HEALTH;
    let peakCpu = 0;
    let peakTreeCpu = 0;
    let peakMem = 0;
    let stuck = 0;
    for (const s of samples) {
        peakCpu = Math.max(peakCpu, s.cpuPercent);
        peakTreeCpu = Math.max(peakTreeCpu, s.treeCpuPercent ?? s.cpuPercent);
        peakMem = Math.max(peakMem, s.memoryRssKb ?? 0);
        if (judgeHealth(s, policy).verdict === "stuck") stuck += 1;
    }
    const last = samples[samples.length - 1]!;
    const diagnosis = judgeHealth(last, policy);
    return {
        samples: samples.length,
        stuckSamples: stuck,
        peakCpuPercent: round1(peakCpu),
        peakTreeCpuPercent: round1(peakTreeCpu),
        peakMemoryKb: Math.round(peakMem),
        lastChildCount: last.childCount,
        lastOutputBytes: last.outputBytes,
        lastSilentMs: last.silentMs,
        lastVerdict: diagnosis.verdict,
        lastRule: diagnosis.rule,
        lastReason: diagnosis.reason,
    };
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

// ═══════════════════════════════════════════════
//  成账文案（CLI / 面板 / 日志同一份）
// ═══════════════════════════════════════════════

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m${Math.round(s - m * 60)}s`;
}

export interface RunSummaryInput {
    readonly outcome: RunOutcome;
    readonly ms: number;
    readonly exitCode?: number;
    readonly signal?: string;
    /** 累计产出字节（不是环里还剩多少） */
    readonly outputBytes: number;
    /** 因环容量丢掉的字节（>0 = 详情页的 tail 不是全量） */
    readonly droppedBytes: number;
    readonly health: RunHealthSummary;
}

/**
 * 一句话结果（`JobRun.summary`）。
 *
 * 为什么值得一个纯函数而不是拼在调用点：它是**面板 / CLI / 账本三处共用的同一句话**，
 * 拼三遍必然分叉（比如「丢弃」那段的单位、峰值取舍），而分叉只会在事后排查时才被发现。
 */
export function buildRunSummary(input: RunSummaryInput): string {
    const parts: string[] = [describeOutcome(input.outcome), fmtDuration(input.ms)];
    if (input.exitCode !== undefined) parts.push(`退出码 ${input.exitCode}`);
    if (input.signal) parts.push(`信号 ${input.signal}`);
    parts.push(
        input.droppedBytes > 0
            ? `输出 ${fmtBytes(input.outputBytes)}（已丢头 ${fmtBytes(input.droppedBytes)}）`
            : `输出 ${fmtBytes(input.outputBytes)}`,
    );
    const h = input.health;
    if (h.samples > 0) {
        parts.push(
            `CPU 峰值 ${h.peakTreeCpuPercent}%（树）` +
                (h.peakMemoryKb > 0 ? ` · 内存峰值 ${fmtBytes(h.peakMemoryKb * 1024)}` : "") +
                ` · 采样 ${h.samples} 次${h.stuckSamples > 0 ? `（${h.stuckSamples} 次判卡住）` : ""}`,
        );
    } else {
        parts.push("未采样（无人查看）");
    }
    return parts.join(" · ");
}

// ═══════════════════════════════════════════════
//  标识与标题
// ═══════════════════════════════════════════════

/** 命令首行 → 人话标题（面板 / CLI 的一行）。空命令给一个不撒谎的占位。 */
export function jobTitleOf(cmd: string, maxChars = 72): string {
    const firstLine = cmd.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    const text = firstLine.replace(/\s+/g, " ");
    if (text.length === 0) return "(空命令)";
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** FNV-1a 32 位（不引 crypto：这里只要「同一件事撞同一个桶」，不需要抗碰撞强度）。 */
function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/**
 * 由「哪个任务的哪个目录跑了什么命令」导出 jobId。
 *
 * 同一 task + cwd + 命令 ⇒ **同一个 jobId**：面板/CLI 才能把「这条命令跑过 8 次」折叠成一行
 * （用户原话：定时器是 1:n 的列表；spawned 也一样 —— 定义是命令，run 是每次执行）。
 * 形状必须过 `isSafeJobId`（账本文件名）：`spawn-<slug>-<hash8>`，slug 只留 `[a-z0-9]`。
 */
export function jobIdOfTaskCommand(taskUri: string, cwd: string, cmd: string): string {
    const head = cmd.trim().split(/\s+/)[0] ?? "";
    const slug = head
        .replace(/^.*\//, "")
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 16)
        .toLowerCase();
    const hash = fnv1a(`${taskUri}\u0000${cwd}\u0000${cmd}`);
    return `spawn-${slug || "cmd"}-${hash}`;
}

/** run id：`r<epoch36>-<rand4>` —— 唯一、可排序、也是 log 文件名（必须过 `isSafeJobId`）。 */
export function makeRunId(nowMs: number, rand: () => number = Math.random): string {
    const rand4 = Math.floor(rand() * 0x10000)
        .toString(16)
        .padStart(4, "0");
    return `r${nowMs.toString(36)}-${rand4}`;
}

/** 会话里跑的这条命令的 cwd 是否与任务 cwd 不同（诊断用；面板可标「在子目录跑的」）。 */
export function describeOriginTask(taskUri: string, turnId: string, stepId: string): string {
    return `${taskUri} · ${turnId} · ${stepId}`;
}
