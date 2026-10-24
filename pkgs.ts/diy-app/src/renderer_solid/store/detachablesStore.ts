/**
 * detachablesStore — 「哪条前台工具调用现在能转后台」（##408 刀 21）。
 *
 * 数据源只有一个：main 侧 `diy.job.detachables`（= `foreground-bash` 那张内存表）。
 * 本 store 不自己判「能不能转」—— 判据在 main（还在跑 / 有 toolCallId / 本任务），
 * 渲染层只做一件事：拿到一组 `toolCallId`，在对应的工具行上画按钮。
 *
 * ── 为什么轮询而不是事件 ──
 *   「能转」是一个**会自己消失**的状态（命令跑完就没），没有事件可挂；而它每次只回几个 id，
 *   比 run 表（要 stat 日志）轻得多。2s 一次，且只在页面可见时跑。
 *
 * ── 转成功后为什么不在这里改 run 面板 ──
 *   转后台的归属全在 run 表（`job.ps`）：面板下一次轮询自然就看见它了。
 *   这里只把该 id 从"可转集合"里摘掉（`refresh()` 就会摘，因为 main 那边已经删了条目）。
 */
import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

/** 面板刷新节奏：比 run 表（3s）快一点 —— 按钮晚 3s 出现，用户会以为"没这功能" */
const POLL_MS = 2000;

const [ids, setIds] = createSignal<ReadonlySet<string>>(new Set());
const [error, setError] = createSignal<string | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;
let taskUri: string | null = null;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
    if (inflight) return inflight;
    const uri = taskUri;
    if (!uri) return;
    const run = (async () => {
        try {
            const r = await diyService.diy.job.detachables({ taskUri: uri });
            const items = ((r.data as { items?: { toolCallId: string }[] } | undefined)?.items ?? []) as {
                toolCallId: string;
            }[];
            setIds(new Set<string>(items.map((i) => i.toolCallId)));
            setError(null);
        } catch (e) {
            // 读不到就清空（不画按钮）—— 但**记下原因**：否则看起来像"这功能不存在"
            setIds(new Set<string>());
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            inflight = null;
        }
    })();
    inflight = run;
    return run;
}

export const detachablesStore = {
    /** 这块工具调用现在能转后台？（渲染层唯一读的口） */
    has(toolCallId: string): boolean {
        return ids().has(toolCallId);
    },
    count(): number {
        return ids().size;
    },
    /** 当前可转的全部 toolCallId（`Cmd+B` 一把转用） */
    all(): string[] {
        return [...ids()];
    },
    error: error,
    /** 进入某任务的会话时开始盯（重复调用同一任务不叠加定时器） */
    watch(uri: string): void {
        if (taskUri === uri && timer) return;
        this.stop();
        taskUri = uri;
        void refresh();
        timer = setInterval(() => {
            // 窗口不可见时别烧 CPU（与 job 面板同一理由）
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            void refresh();
        }, POLL_MS);
    },
    stop(): void {
        if (timer) clearInterval(timer);
        timer = null;
        taskUri = null;
        setIds(new Set<string>());
    },
    /** 转一条；返回给用户看的一句话（失败也照实说，不静默） */
    async detach(toolCallId: string): Promise<string> {
        try {
            const r = await diyService.diy.job.detach({ toolCallId, taskUri: taskUri ?? "" });
            // 返回是判别联合（ok / error），取不到 id 就如实说"?"，不猜
            const data = "data" in r ? (r.data as { id?: string } | undefined) : undefined;
            await refresh();
            return `已转后台：${data?.id ?? "?"}（结束时它会插话叫醒 agent）`;
        } catch (e) {
            await refresh();
            return `转后台失败：${e instanceof Error ? e.message : String(e)}`;
        }
    },
};
