/**
 * jobRunsStore — 面板侧的 job 只读快照（##408 刀 6）。
 *
 * 数据源**只有一个**：main 侧的 `diy.job.ls` / `diy.job.show`（= 刀 5 落的执行账 + 进程内活体）。
 * 本 store **不新造存储、不猜状态**：列表中每行都对应账本一条或活体一条，拿不到就如实报错/空。
 *
 * ── 为什么轮询只在面板可见时跑 ──
 *   `job.ls` 会读 `$DIY_HOME/jobs/*.jsonl` 全部账本（解析 JSON 有成本）。任务页开着但没人看作业列表时
 *   每 3s 扫一遍全量账本 = 白烧 CPU（这正是 ##401 要治的"后台空转"）。故 `watch()` 由**面板自己**
 *   在挂载时调、卸载时停；任务页只做一次「本任务有没有 job」的探底（决定要不要把底栏打开）。
 *
 * ── 导航请求为什么放这里 ──
 *   点「来源」要跨组件（作业面板 → 会话页）：先 `openTaskRun(uri)` 切页，再让会话页自己去定位。
 *   若中间没有一份**待办**，会话页挂载完成的那一刻就错过了这次请求（时序不稳定 ⇒ 有时跳有时不跳）。
 *   故这里存一份 latest-wins 的待定位请求，会话页挂载/切任务时**取走**（取走即清，不重复跳）。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { JobRun } from "../../shared/job-run";
import type { JobNavTarget, LiveRunRef } from "../../shared/job-runs-view";
import { liveOfTask, runsOfTask } from "../../shared/job-runs-view";

/** `diy.job.ls` 的数据形状（只取面板要用的部分；真源 `main/services/job-view.ts::JobListView`） */
export interface JobSnapshot {
    readonly runs: readonly JobRun[];
    readonly live: readonly LiveRunRef[];
    /** 坏行数（观测数据可腐烂；>0 时面板要提一句，不能装作没这回事） */
    readonly skippedRows: number;
    readonly ledgerFiles: number;
}

const EMPTY: JobSnapshot = { runs: [], live: [], skippedRows: 0, ledgerFiles: 0 };

const [snap, setSnap] = createSignal<JobSnapshot>(EMPTY);
const [error, setError] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(false);
const [pendingNav, setPendingNav] = createSignal<JobNavTarget | null>(null);

/** 面板可见时的刷新节奏。3s：与任务页成员栏同量级，人感觉"实时"，而账本读取仍远低于一帧的预算 */
const POLL_MS = 3000;

let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 立刻刷一次（并发调用合流：同一时刻只发一次请求） */
async function refresh(opts: { limit?: number } = {}): Promise<void> {
    if (inflight) return inflight;
    const run = (async () => {
        setLoading(true);
        try {
            const r = await diyService.diy.job.ls({ limit: opts.limit, live: true });
            const data = r.data as Partial<JobSnapshot> | undefined;
            setSnap({
                runs: (data?.runs ?? []) as JobRun[],
                live: (data?.live ?? []) as LiveRunRef[],
                skippedRows: data?.skippedRows ?? 0,
                ledgerFiles: data?.ledgerFiles ?? 0,
            });
            setError(null);
        } catch (e) {
            // 读不到 ≠ 没有 job：报错与空列表必须区分开（否则用户以为"活干完了"）
            setError(`读作业账本失败：${msgOf(e)}`);
        } finally {
            setLoading(false);
            inflight = null;
        }
    })();
    inflight = run;
    return run;
}

export const jobRunsStore = {
    get snapshot(): JobSnapshot {
        return snap();
    },
    get error(): string | null {
        return error();
    },
    get loading(): boolean {
        return loading();
    },
    refresh,
    /** 本任务的 run（时间升序） */
    runsFor(taskUri: string): JobRun[] {
        return runsOfTask(snap().runs, taskUri);
    },
    /** 本任务正在跑的（含还没落账的） */
    liveFor(taskUri: string): LiveRunRef[] {
        return liveOfTask(snap().live, taskUri);
    },
    /**
     * 开始轮询（返回停止函数；引用计数，多个面板实例共用一个定时器）。
     * 只在**面板挂载期**调 —— 见文件头注。
     */
    watch(): () => void {
        watchers += 1;
        if (timer === null) {
            void refresh();
            timer = setInterval(() => void refresh(), POLL_MS);
        }
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            watchers -= 1;
            if (watchers <= 0 && timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
    },
    // ─── 跨组件导航请求（latest-wins）────────────────────────────
    requestNav(target: JobNavTarget): void {
        setPendingNav(target);
    },
    /** 反应式读取（会话页 effect 用它；不改状态） */
    get pendingNav(): JobNavTarget | null {
        return pendingNav();
    },
    /**
     * 取走属于该任务的待导航请求（取走即清）。
     *
     * 「取走」而不是「保留」：定位是一次性动作，留着会让每次切回该任务都重新跳一次，
     * 而用户此刻可能在读别的地方 —— 那正是"抢滚动"的来源。
     */
    takeNav(taskUri: string): JobNavTarget | null {
        const p = pendingNav();
        if (!p || p.taskUri !== taskUri) return null;
        setPendingNav(null);
        return p;
    },
    /** 清空（测试 / 退出登录态） */
    reset(): void {
        setSnap(EMPTY);
        setError(null);
        setPendingNav(null);
    },
};
