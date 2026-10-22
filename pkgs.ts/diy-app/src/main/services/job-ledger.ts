// src/main/services/job-ledger.ts
// 🎯 后台 job 的**执行账**：append-only JSONL，一次 run 一行（##408 刀 2）。
//
// 落点：`$DIY_HOME/jobs/<jobId>.jsonl`（home 走 `src/runtime.ts`，不硬编码）。
// 定义**不落盘**（job 定义在代码里注册，代码即真源）；这里只落「发生过什么」。
// 于是「配置文件 vs 代码」两份真源的经典坑在本模块不存在。
//
// 三条口径：
//   ① **append-only**：一行只写一次，终态是**新写的一行**（不是改旧行）——
//      观测数据要能被 tail 出时间线，改写会丢历史（`shared/job-run.ts::RUN_TRANSITIONS`）。
//   ② **坏行跳过不抛**：账是观测数据，可腐烂（半行 / 手改 / 旧格式）。读侧跳过坏行继续，
//      绝不因为一行烂数据炸掉业务 —— 但也**不静默**（`console.warn` 一行，便于发现系统性腐坏）。
//   ③ **不做保留策略**：清理 / 轮转属 ##410，越界会把「谁负责删」搅浑（本刀只 append + read）。

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRuntimeConfig } from "../../runtime";
import { assertJobId, normalizeRun, type JobRun, type JobRunState } from "../../shared/job-run";

/** job 账本目录：`$DIY_HOME/jobs/`。 */
export function jobsDir(home: string = readRuntimeConfig().home): string {
    return join(home, "jobs");
}

/** 单个 job 的账本文件：`$DIY_HOME/jobs/<jobId>.jsonl`。 */
export function jobLedgerPath(jobId: string, home: string = readRuntimeConfig().home): string {
    assertJobId(jobId);
    return join(jobsDir(home), `${jobId}.jsonl`);
}

/**
 * 同文件的 append 串行链（key = 绝对路径）。
 *
 * 为什么不是「直接 appendFile 就行」：单次 `write(2)` 带 O_APPEND 在 POSIX 上有定位原子性，
 * 但 Node 的 `appendFile` 在**大载荷**下可能分多次 write，且同进程内的**调用顺序 ≠ 落盘顺序**
 * （await 交错）—— 一次长任务的 `running` 行可能排到自己的 `settled` 行之后。
 * 串行链同时解决两件事：不撕行 + 账本内**顺序与提交顺序一致**（时间线才对得起来）。
 */
const appendChains = new Map<string, Promise<void>>();

function chainAppend(path: string, line: string): Promise<void> {
    const prev = appendChains.get(path) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => appendFile(path, line, "utf-8"));
    // 链尾失败也要把后继放出来（否则一次 ENOSPC 会让这个文件永久写不进 —— 病态放大）
    appendChains.set(
        path,
        next.catch(() => {}),
    );
    return next;
}

export interface AppendRunOptions {
    /** 覆盖 home（测试用；缺省 `src/runtime.ts` 解析）。 */
    readonly home?: string;
    /** 注入时钟（测试不真等）。 */
    readonly now?: number;
}

/**
 * 追加一条 run 记录。
 *
 * 落盘形状 = `{ ts, ...run }`：`ts` 是**写入时刻**（与本条 run 自身的 `startedAt` 不是一个概念 ——
 * 终态行是 run 结束后才写的，两者差一个耗时）。读侧排序一律用 `startedAt`，`ts` 只在
 * 「文件被手改过 / 时钟回拨」这类腐坏排查时当交叉证据。
 *
 * 返回归一化后的 run（调用点拿它继续用，免得再 normalize 一遍）。
 * origin 缺失 / 非法在这里就会抛 `agent/missing-origin`（硬约束 1）：**账本只收有来源的 run**。
 */
export async function appendRun(run: JobRun, opts: AppendRunOptions = {}): Promise<JobRun> {
    const normalized = normalizeRun(run);
    const path = jobLedgerPath(normalized.jobId, opts.home);
    await mkdir(jobsDir(opts.home), { recursive: true });
    const row = { ts: new Date(opts.now ?? Date.now()).toISOString(), ...normalized };
    await chainAppend(path, `${JSON.stringify(row)}\n`);
    return normalized;
}

export interface ReadRunsOptions {
    readonly home?: string;
    /** 只要最近 N 条（缺省全部）。按**写入顺序**取尾部 = 最近的 run。 */
    readonly limit?: number;
}

export interface ReadRunsResult {
    readonly runs: readonly JobRun[];
    /** 跳过多少坏行（>0 说明账本有腐坏；调用点可据此提示，但**不影响**本次读取） */
    readonly skipped: number;
}

/**
 * 读一个 job 的全部 run（正序 = 写入顺序 = 时间线顺序）。
 *
 * 空文件 / 文件不存在 ⇒ 空列表（「还没跑过」不是错误）。
 * 坏行（JSON 解不开 / 形状不对 / origin 缺失）⇒ 跳过并计入 `skipped`。
 */
export async function readRunsDetailed(jobId: string, opts: ReadRunsOptions = {}): Promise<ReadRunsResult> {
    const path = jobLedgerPath(jobId, opts.home);
    let text: string;
    try {
        text = await readFile(path, "utf-8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], skipped: 0 };
        throw e; // 权限 / IO 故障不是「账本腐坏」，不能当空账吞掉
    }
    const runs: JobRun[] = [];
    let skipped = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue; // 尾行 / 空行：不是坏行
        try {
            const parsed: unknown = JSON.parse(line);
            // `ts` 是落盘壳（写入时刻），不是 JobRun 的字段 —— 摘掉再归一化，
            // 否则 `.strict()` 会把它当陌生键、把**每一行**都判成坏行。
            const row: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...(parsed as Record<string, unknown>) } : {};
            delete row["ts"];
            runs.push(normalizeRun(row));
        } catch {
            skipped += 1;
            console.warn(`[job-ledger] 跳过坏行 ${path}:${i + 1}`);
        }
    }
    return { runs: opts.limit !== undefined ? runs.slice(-opts.limit) : runs, skipped };
}

/** 同上，只要 run 列表（绝大多数调用点）。 */
export async function readRuns(jobId: string, opts: ReadRunsOptions = {}): Promise<readonly JobRun[]> {
    return (await readRunsDetailed(jobId, opts)).runs;
}

/**
 * 最近一次 run 的状态；没有账（文件不存在或全是坏行）= null。
 *
 * 「重启恢复」判据靠它：`running` + pid 已死 ⇒ 补一条 `lost`（刀 3）。
 * 这里只回答「账上最后写了什么」，**不**在这里做 pid 探测（那是有 IO + 平台差异的活，归注册表）。
 */
export async function latestState(jobId: string, opts: ReadRunsOptions = {}): Promise<JobRunState | null> {
    const runs = await readRuns(jobId, { ...opts, limit: 1 });
    return runs.length > 0 ? runs[runs.length - 1]!.state : null;
}

/** 最近一次 run（面板/CLI 的「上次结果」列直接用它）。 */
export async function latestRun(jobId: string, opts: ReadRunsOptions = {}): Promise<JobRun | null> {
    const runs = await readRuns(jobId, { ...opts, limit: 1 });
    return runs.length > 0 ? runs[runs.length - 1]! : null;
}

/** 类型再导出：消费方（刀 3/5）不必再引一层 `shared/job-run`。 */
export type { JobRun, JobRunState };

/** 一条跨文件的 run（`readAllRuns` 的产物）：带上它的 jobId 就是 `run.jobId`，这里不再重复。 */
export interface AllRunsResult {
    /** 按 `startedAt` **升序**（时间线顺序；同刻按写入顺序） */
    readonly runs: readonly JobRun[];
    /** 跳过多少坏行（跨全部文件累计） */
    readonly skipped: number;
    /** 读过几个账本文件 */
    readonly files: number;
}

/**
 * 读**所有** job 的 run（`diy job ls` 的口径：一次看完昨天跑了些什么）。
 *
 * 为什么不放在 CLI 里自己遍历：账本文件名 / 坏行容忍 / `ts` 摘壳三条口径只有这里一份，
 * 复制出去必然分叉（第一版就会漏 `ts` ⇒ 每一行都判坏行）。
 *
 * 空目录 / 目录不存在 ⇒ 空列表。单个文件读失败（权限 / 被删）⇒ 跳过该文件并计入 `skipped`，
 * **不**让一个坏文件拖垮整个列表（观测数据可腐烂）。
 */
export async function readAllRuns(opts: { home?: string } = {}): Promise<AllRunsResult> {
    const dir = jobsDir(opts.home);
    let names: string[];
    try {
        names = await readdir(dir);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], skipped: 0, files: 0 };
        throw e;
    }
    const runs: JobRun[] = [];
    let skipped = 0;
    let files = 0;
    for (const name of names.sort()) {
        if (!name.endsWith(".jsonl")) continue;
        files += 1;
        const jobId = name.slice(0, -".jsonl".length);
        try {
            const r = await readRunsDetailed(jobId, opts);
            runs.push(...r.runs);
            skipped += r.skipped;
        } catch {
            skipped += 1; // 整个文件读不动 = 至少一条「取不到」的证据
            console.warn(`[job-ledger] 跳过不可读账本 ${dir}/${name}`);
        }
    }
    // 时间线顺序：startedAt 升序；同刻保持文件内写入顺序（稳定排序 + files 已排序）
    runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    return { runs, skipped, files };
}
