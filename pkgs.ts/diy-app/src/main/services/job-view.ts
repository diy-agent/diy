// src/main/services/job-view.ts
// 🎯 job 的**只读视图装配**（##408 刀 5）：CLI `diy job ls|show` 的数据源。
//
// 为什么单独一层而不是把逻辑写进 api-impl：视图口径（怎么分组、tail 留多少、live 与账怎么合）
// 是**产品判断**，会随面板需求变；api-impl 只该做「参数 → 调用 → 返回」。分开后
// 面板 / 意图测试 / CLI 能共用同一份口径，不必各拼一遍。
//
// 三条口径：
//   ① `ls` 默认给**账本里的历史**（含在跑的 `running` 行），`live` 字段额外给「还没落账的」——
//      后者是阈值之下的短命令 / 无输出的长命令（见 `spawned-jobs.ts` 头注 ②）。
//   ② `show` 接受 **jobId 或 runId**：前者给该命令的 1:n 时间线（用户要的形态），后者只一条。
//   ③ 采样（`--sample`）**只在 show 上做**：`top -l 2` ~1s，列表页不该为它付钱。

import { readFile } from "node:fs/promises";
import type { JobRun } from "../../shared/job-run";
import type { LiveRunView } from "./spawned-jobs";
import { jobLogPath, spawnedJobs, type SpawnedJobTracker } from "./spawned-jobs";
import { readAllRuns, type ReadRunsResult } from "./job-ledger";
import { fmtBytes } from "../../shared/spawned-job";

/** 一个 jobId 的折叠行（面板父行 / CLI 分组视图）。 */
export interface JobGroup {
    readonly jobId: string;
    /** 最近一次 run 的标题（定义删了也读得懂） */
    readonly title: string;
    /** **不同 run 的次数**（不是账本行数：一次 run 有 running + 终态两行，别重复计） */
    readonly runs: number;
    readonly lastState: JobRun["state"];
    readonly lastStartedAt: string;
    readonly lastOutcome: JobRun["outcome"] | null;
    readonly lastSummary: string | null;
    /** 正在跑的次数（0 = 没有活的） */
    readonly running: number;
}

export interface JobListView {
    /** 展平的 run 列表（按 startedAt 升序 = 时间线） */
    readonly runs: readonly JobRun[];
    /** 同一 jobId 的折叠视图（按 lastStartedAt **降序** = 最近跑过的在前） */
    readonly groups: readonly JobGroup[];
    /** 正在跑、尚未收口的（含未落账的短命令）—— `--no-live` 时为空 */
    readonly live: readonly LiveRunView[];
    readonly skippedRows: number;
    readonly ledgerFiles: number;
}

export interface JobListOptions {
    readonly home?: string;
    /** 只看最近 N 条 run（缺省全部） */
    readonly limit?: number;
    /** 是否带上进程内 live 视图（缺省带） */
    readonly includeLive?: boolean;
    /** 注入活体表（测试用；缺省生产单例）—— 别让单测去碰全局单例 */
    readonly tracker?: SpawnedJobTracker;
}

function groupOf(runs: readonly JobRun[], live: readonly LiveRunView[]): JobGroup[] {
    const map = new Map<string, JobRun[]>();
    for (const r of runs) {
        const list = map.get(r.jobId);
        if (list) list.push(r);
        else map.set(r.jobId, [r]);
    }
    const groups: JobGroup[] = [];
    for (const [jobId, list] of map) {
        const last = list[list.length - 1]!;
        const running = live.filter((v) => v.jobId === jobId).length;
        groups.push({
            jobId,
            title: last.title,
            runs: new Set(list.map((r) => r.id)).size,
            lastState: last.state,
            lastStartedAt: last.startedAt,
            lastOutcome: last.outcome ?? null,
            lastSummary: last.summary ?? null,
            running,
        });
    }
    groups.sort((a, b) => (a.lastStartedAt < b.lastStartedAt ? 1 : a.lastStartedAt > b.lastStartedAt ? -1 : 0));
    return groups;
}

/** `diy job ls` 的数据源。 */
export async function jobList(opts: JobListOptions = {}): Promise<JobListView> {
    let ledger: ReadRunsResult & { files: number };
    try {
        ledger = await readAllRuns(opts.home !== undefined ? { home: opts.home } : {});
    } catch (e) {
        // 账本目录读不动（权限）不该让「看看有哪些 job」整个失败 —— 但也不能装成空的
        console.warn("[job-view] 读账本失败:", e);
        ledger = { runs: [], skipped: 0, files: 0 };
    }
    const all = opts.limit !== undefined ? ledger.runs.slice(-opts.limit) : ledger.runs;
    const tracker = opts.tracker ?? spawnedJobs;
    const live = opts.includeLive === false ? [] : tracker.live();
    return {
        runs: all,
        groups: groupOf(all, live),
        live,
        skippedRows: ledger.skipped,
        ledgerFiles: ledger.files,
    };
}

export interface JobShowView {
    /** 命中的 run（按 startedAt 升序） */
    readonly runs: readonly JobRun[];
    /** 命中的在所有命中里**最后一条**（CLI 的"当前状态"一行） */
    readonly current: JobRun | null;
    readonly group: JobGroup | null;
    /** 进程内的活体视图（同 id 正在跑时才有） */
    readonly live: (LiveRunView & { liveText: string; settleText: string; frozen: boolean }) | null;
    /** settle 日志尾部（`logPath` 存在且读得到才给） */
    readonly logTail: string | null;
    readonly logPath: string | null;
}

export interface JobShowOptions {
    readonly home?: string;
    /** 采一份现场（真跑 top/ps/lsof，~1s）；缺省 false —— 查询不该有副作用 */
    readonly sample?: boolean;
    /** logTail 的字节上限（缺省 16KB，与 settle 环同量级） */
    readonly tailBytes?: number;
    /** 注入活体表（测试用；缺省生产单例） */
    readonly tracker?: SpawnedJobTracker;
}

/**
 * `diy job show <jobId|runId>` 的数据源。
 *
 * 命中口径：`runs` 一律是**账本行**（append-only，一条 run 会有 `running` + 终态两行），
 * `current` 取最后一行 = 该 run 的当前状态；`group.runs` 才是「跑了几次」（按 run id 去重）。
 *
 * 找不到就返回全空（`runs: []` / `live: null`）—— 「没有这条」是**查询结果**，不是错误
 * （CLI 侧据此 exit 0 + 空列表，与 `task show` 的严格口径不同：那是编辑目标，这是观测面）。
 */
export async function jobShow(id: string, opts: JobShowOptions = {}): Promise<JobShowView> {
    // ① 进程内活体优先（未落账的短命令只能从这里看到）
    const tracker = opts.tracker ?? spawnedJobs;
    const handle = tracker.get(id);
    let live: JobShowView["live"] = null;
    if (handle) {
        if (opts.sample) handle.sampleNow();
        const view = handle.snapshot();
        const out = handle.outputSnapshot();
        live = { ...view, liveText: out.live, settleText: out.settle, frozen: out.frozen };
    }

    // ② 账本：按 runId 精确命中，或按 jobId 取整条时间线
    let runs: readonly JobRun[] = [];
    try {
        const ledger = await readAllRuns(opts.home !== undefined ? { home: opts.home } : {});
        runs = ledger.runs.filter((r) => r.jobId === id || r.id === id);
    } catch (e) {
        console.warn("[job-view] 读账本失败:", e);
    }
    if (live && runs.length === 0) {
        // 活体存在但还没落账：用 live 视图补一条"当前状态"（state=running 由视图表达）
        runs = [];
    }
    const current = runs.length > 0 ? runs[runs.length - 1]! : null;
    const group = current ? (groupOf(runs, live ? [live] : []).find((g) => g.jobId === current.jobId) ?? null) : null;

    // ③ settle 日志尾部（只在账上有 logPath 时读）
    let logTail: string | null = null;
    let logPath: string | null = current?.logPath ?? null;
    if (!logPath && current) logPath = null;
    if (!logPath && handle) logPath = jobLogPath(handle.id, opts.home);
    if (logPath) {
        try {
            const text = await readFile(logPath, "utf-8");
            const cap = opts.tailBytes ?? 16 * 1024;
            logTail =
                text.length > cap
                    ? `…（前 ${fmtBytes(Buffer.byteLength(text, "utf-8") - cap)} 已截断）\n${text.slice(-cap)}`
                    : text;
        } catch {
            // 文件不在（只跑过没落日志 / 被清理）⇒ 如实给 null，不编造
            logTail = null;
            if (!current?.logPath) logPath = null;
        }
    }

    return { runs, current, group, live, logTail, logPath };
}

export type { JobRun };
