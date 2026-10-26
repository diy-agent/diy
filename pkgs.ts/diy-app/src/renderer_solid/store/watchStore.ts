/**
 * watchStore — 面板侧的 **JobWatch 快照**（##408 v2 刀 4）。
 *
 * 数据源只有一个：main 侧 `diy.job.watch.list`（结构化行，`api-impl.ts` 的 `watchRow`）。
 * 本 store 不猜状态：`state` / `nextDueAt` / `intervalMin` 都是 main 现算出来的，
 * 这边只做「什么时候再拉一次」。
 *
 * ── 为什么是 10s 而不是 3s ──
 *   run 表那 3s 是因为「进程随时起落」；watch 的最小节奏是 1 分钟，10s 已比它细一个量级。
 *   再快只是在白烧 IO。而且**没有 watch 时自动停轮询** —— 空转正是 ##401 要治的毛病。
 *
 * ── 为什么不做写操作缓存 ──
 *   `peek` / `rm` 都是「点一下 → 立刻重新拉」：watch 的数量是几个到几十个，
 *   不需要乐观更新那套复杂度。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

/** 一行 watch（真源 `main/services/api-impl.ts::watchRow`）。 */
export interface WatchRow {
    readonly id: string;
    readonly title: string;
    readonly enabled: boolean;
    readonly every: number;
    /** 此刻生效的间隔（降频后与 `every` 不同） */
    readonly intervalMin: number;
    readonly probes: readonly string[];
    readonly sinks: readonly string[];
    /** `run:<id>` / `task:<uri>` / `command:<key>` / `none` */
    readonly subject: string;
    readonly createdAt: string;
    /** `watching` / `quiet` / `broken` / `ended` / `new` / `paused` */
    readonly state: string;
    readonly due: boolean;
    readonly nextDueAt: number | null;
    readonly lastProbeAt: number | null;
    readonly lastChangeAt: number | null;
    readonly probesRun: number;
    readonly quietStreak: number;
    readonly errorStreak: number;
    readonly lastError: string | null;
    readonly ended: { readonly at: number; readonly reason: string } | null;
}

interface Snapshot {
    readonly watches: readonly WatchRow[];
    readonly total: number;
    readonly at: number | null;
}

const EMPTY: Snapshot = { watches: [], total: 0, at: null };

const [snap, setSnap] = createSignal<Snapshot>(EMPTY);
const [error, setError] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(false);

const POLL_MS = 10_000;

let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 立刻拉一次（并发合流）。 */
async function refresh(all = false): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
        setLoading(true);
        try {
            const r = await diyService.diy.job.watch.list({ all });
            // 失败分支只有 `{ status, msg }`：读不到就报错，不伪造空表
            if (!("data" in r)) {
                setError(`读观察表失败：${r.msg}`);
                return;
            }
            const data = r.data as Partial<Snapshot> | undefined;
            setSnap({
                watches: (data?.watches ?? []) as WatchRow[],
                total: data?.total ?? 0,
                at: Date.now(),
            });
            setError(null);
        } catch (e) {
            // 读不到 ≠ 没有 watch：两者必须区分（否则用户以为「一个都没在盯」）
            setError(`读观察表失败：${msgOf(e)}`);
        } finally {
            setLoading(false);
            inflight = null;
        }
    })();
    return inflight;
}

/** 开始轮询（组件挂载时调；重复调用只算一个订阅者）。 */
function watch(): () => void {
    watchers += 1;
    void refresh();
    if (!timer) timer = setInterval(() => void refresh(), POLL_MS);
    let closed = false;
    return () => {
        if (closed) return; // 幂等：重复调退订不该把计数减成负数
        closed = true;
        watchers -= 1;
        if (watchers <= 0 && timer) {
            clearInterval(timer);
            timer = null;
        }
    };
}

/** 立刻探一次（不进任何账；返回值直接给人看）。 */
async function peek(id: string): Promise<{ verdict: string; diff: string } | null> {
    try {
        const r = await diyService.diy.job.watch.peek({ id });
        if (!("data" in r) || r.status !== "ok") return null;
        const d = r.data as { verdict: string; diff: string } | undefined;
        return d ? { verdict: d.verdict, diff: d.diff } : null;
    } catch {
        return null;
    }
}

export const watchStore = {
    get snapshot(): Snapshot {
        return snap();
    },
    get error(): string | null {
        return error();
    },
    get loading(): boolean {
        return loading();
    },
    refresh,
    watch,
    peek,
    /** 生效中的（未 ended、未暂停）—— 胶囊上的数字只数这些。 */
    active(): readonly WatchRow[] {
        return snap().watches.filter((w) => w.ended === null && w.enabled);
    },
    /** 坏掉的条数（胶囊变红的判据 —— 与 `watchRow.state === "broken"` 同源，不另判）。 */
    brokenCount(): number {
        return this.active().filter((w) => w.state === "broken").length;
    },
    /** 某个任务在盯的（`sinks` 里有 `task:<uri>`）—— 浮层里「当前任务」高亮的判据。 */
    forTask(taskUri: string): readonly WatchRow[] {
        const addr = `task:${taskUri}`;
        return snap().watches.filter((w) => w.sinks.includes(addr));
    },
};
