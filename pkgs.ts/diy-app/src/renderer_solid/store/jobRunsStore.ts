/**
 * jobRunsStore — 面板侧的 **run 活体表**快照（##408 刀 9 起改用 `diy.job.ps`）。
 *
 * 数据源**只有一个**：main 侧的 `diy.job.ps`（= 内存活体表；刀 8 起再没有"执行账"这回事）。
 * 本 store 不新造存储、不猜状态：拿不到就如实报错/空。
 *
 * ── 为什么轮询只在面板可见时跑 ──
 *   `job.ps` 要 stat 每条 run 的 out.log（拿字节数）。任务页开着但没人看作业面板时每 3s 扫一遍
 *   = 白烧 CPU（正是 ##401 要治的"后台空转"）。故 `watch()` 由**面板自己**在挂载时调、卸载时停；
 *   任务页只做一次「本任务有没有 run」的探底（决定要不要把底栏打开）。
 *
 * ── 导航请求为什么放这里 ──
 *   点「来源」要跨组件（作业面板 → 会话页）：先 `openTaskRun(uri)` 切页，再让会话页自己去定位。
 *   若中间没有一份**待办**，会话页挂载完成的那一刻就错过了这次请求（时序不稳定 ⇒ 有时跳有时不跳）。
 *   故这里存一份 latest-wins 的待定位请求，会话页挂载/切任务时**取走**（取走即清，不重复跳）。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { ProcRow, RunView } from "../../shared/run-view";
import type { JobNavTarget } from "../../shared/job-runs-view";

/** `diy.job.ps` 的数据形状（真源 `main/services/api-impl.ts` + `shared/run-view.ts::RunView`） */
export interface RunsSnapshot {
    readonly runs: readonly RunView[];
    /**
     * **没登记**的进程（命令里自己 `nohup xxx &` 起的那种，##408 刀 10）。
     * 它们是 `ps` 里归我们管、但没走过 `run-registry` 的活 —— 也要能看见、能杀。
     */
    readonly untracked: readonly ProcRow[];
    /** 每条 run 名下的进程（根进程退了但子孙还在时这里仍非空） */
    readonly procsByRun: Readonly<Record<string, readonly ProcRow[]>>;
    /** 在跑几条（不分任务 —— 这是全局活体表） */
    readonly running: number;
    /** 表里一共几条（含已结束） */
    readonly total: number;
    /** 上一次 ps 扫描的时刻 / 是否扫成功（失败时不能说"没有进程"） */
    readonly scanAt: number | null;
    readonly scanOk: boolean;
}

const EMPTY: RunsSnapshot = { runs: [], untracked: [], procsByRun: {}, running: 0, total: 0, scanAt: null, scanOk: false };

const [snap, setSnap] = createSignal<RunsSnapshot>(EMPTY);
const [error, setError] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(false);
const [pendingNav, setPendingNav] = createSignal<JobNavTarget | null>(null);

/** 面板可见时的刷新节奏。3s：与任务页成员栏同量级，人感觉"实时"，而 stat 几条文件仍远低于一帧的预算 */
const POLL_MS = 3000;

let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 立刻刷一次（并发调用合流：同一时刻只发一次请求） */
async function refresh(opts: { all?: boolean } = {}): Promise<void> {
    if (inflight) return inflight;
    const run = (async () => {
        setLoading(true);
        try {
            const r = await diyService.diy.job.ps({ all: opts.all !== false, noScan: false });
            const data = r.data as Partial<RunsSnapshot> | undefined;
            setSnap({
                runs: (data?.runs ?? []) as RunView[],
                untracked: (data?.untracked ?? []) as ProcRow[],
                procsByRun: (data?.procsByRun ?? {}) as Record<string, ProcRow[]>,
                running: data?.running ?? 0,
                total: data?.total ?? 0,
                scanAt: data?.scanAt ?? null,
                scanOk: data?.scanOk ?? false,
            });
            setError(null);
        } catch (e) {
            // 读不到 ≠ 没有 run：报错与空列表必须区分开（否则用户以为"活干完了"）
            setError(`读运行表失败：${msgOf(e)}`);
        } finally {
            setLoading(false);
            inflight = null;
        }
    })();
    inflight = run;
    return run;
}

export const jobRunsStore = {
    get snapshot(): RunsSnapshot {
        return snap();
    },
    get error(): string | null {
        return error();
    },
    get loading(): boolean {
        return loading();
    },
    refresh,
    /** 全部 run（"总的运行管理器"视角：不分任务；运行中在前；main 侧已排好序） */
    allRuns(): readonly RunView[] {
        return snap().runs;
    },
    /** 全部未登记进程（不分任务） */
    allUntracked(): readonly ProcRow[] {
        return snap().untracked;
    },
    /** 本任务的 run（活体表里 origin.taskUri 命中本任务的；运行中在前） */
    runsFor(taskUri: string): RunView[] {
        return snap().runs.filter((r) => r.origin?.taskUri === taskUri);
    },
    /**
     * 本任务**未登记**的进程（按"哪条命令起的"归到任务）。
     *
     * 为什么要按任务过滤：面板挂在任务页底栏，列一堆别的任务的进程只会让人以为是自己的。
     * 归不到任务的（`taskUri === null`，例如更早版本的组名册没记任务）一律不显示 ——
     * 宁可少显示也不要让人对着一条不知道哪来的进程按「结束」。
     */
    untrackedFor(taskUri: string): ProcRow[] {
        return snap().untracked.filter((p) => p.taskUri === taskUri);
    },
    /** 某条 run 名下的进程（含根进程；详情里列子树用） */
    procsOfRun(runId: string): ProcRow[] {
        return [...(snap().procsByRun[runId] ?? [])];
    },
    /** 本任务正在跑的条数 */
    runningFor(taskUri: string): number {
        return snap().runs.filter((r) => r.origin?.taskUri === taskUri && r.state === "running").length;
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
