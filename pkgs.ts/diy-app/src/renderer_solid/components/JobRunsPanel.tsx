/**
 * JobRunsPanel — 任务页底栏的「作业」面板（##408；刀 9 运行表 + 三 tab；刀 10 加"未登记进程"）。
 *
 * 用户口径（按时间序，都是原话）：
 *   「先开发页面，不然不知道是怎么运转的，**把原始命令行要显示出来**。表格形式，各种字段。」
 *   「每条记录加个按钮，可以看原文数据的（实际存储和 `diy job show` 的数据），和输出用 tab
 *    分开看切换，即详情分 输出 / API 数据 / 存储数据」
 *   「右上角的几个按钮排列有问题有覆盖现象（最大化 / 最小化 / 刷新）」
 *   「bottonview 的表格和详细中间的横条需要能调节高度拖拉，**和其他横条一致**」
 *   「我希望**所有** job/shell 的进程都通过我们管理器看到」（含命令里自己 `nohup xxx &` 起的）
 *
 * ── 五个刻意的克制 ──
 *   ① **数据源只有一个**：`diy.job.ps`（活体表 + ps 扫描）/ `job.tail` / `job.meta`。
 *      面板不新造存储、不猜状态。
 *   ② **「run」与「未登记进程」是两种东西**，共用表格列但不共用模型：run 有 origin / 终态 /
 *      落盘目录；野进程只有 pid 和命令行。混成一个模型会让 "run" 这个词失真。
 *   ③ **不给每行都拉 tail**：列表只显示字节数（`job.ps` 已 stat），**选中哪行才**读一次输出。
 *   ④ **右内边距留给 area chrome**：chrome 是 `absolute right-0` 浮层不占布局，顶栏必须显式让位，
 *      否则两边盖在同一块像素上（用户报过的 bug）。
 *   ⑤ **横条就是横条**：表格与详情之间那条 6px 的分隔条可拖（和 `ViewGrid` 的线同款手感），
 *      位置记在 localStorage（下次打开还是你调的那档）。
 */

import { createSignal, createMemo, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { jobRunsStore } from "../store/jobRunsStore";
import { AREA_CHROME_W, VIEW_BAR_H } from "../lib/layout-metrics";
import type { ProcRow, RunView } from "../../shared/run-view";
import { bytesText } from "../../shared/run-view";

/** 灯 → class（颜色归主题；这里只选 token，不写具体色值） */
const LAMP_CLASS: Record<string, string> = {
    running: "bg-info",
    exited: "bg-success",
    killed: "bg-warning",
    failed: "bg-error",
    untracked: "bg-base-content/30",
};

/**
 * 详情 tab（刀 14：四页并排，不再上下堆）。
 *
 * 用户实测：「详细栏不要上下结构了，分成 4 个 tab 都放到一起，不然太占高度了」——
 * 原来详情是"标题 + 命令行 pre + 字段表 + tab 内容"竖直堆，底栏两三百 px 高时
 * tab 内容只剩两行；现在命令行/字段全进「概要」页，四页共享同一块高度。
 */
type Tab = "summary" | "output" | "api" | "store";

/** 一行：登记过的 run，或 `ps` 里发现但没登记过的进程 */
type Row = { kind: "run"; run: RunView } | { kind: "proc"; proc: ProcRow };

interface TailView {
    text: string;
    lines: number;
    droppedBytes: number;
    at: number;
}

interface MetaView {
    metaJson: string | null;
    dir: string;
    logPath: string;
    outputBytes: number | null;
}

/** 拖动条的位置（0.15~0.85）—— 只有左右一种布局（刀 14 删掉上下布局） */
const FRAC_KEY_SPLIT = "diy_job_panel_frac_split";

function loadFrac(key: string, fallback: number): number {
    try {
        const n = Number(localStorage.getItem(key));
        if (Number.isFinite(n) && n >= 0.15 && n <= 0.85) return n;
    } catch {
        // localStorage 不可用（隐私模式等）⇒ 用缺省值，不影响功能
    }
    return fallback;
}

export function JobRunsPanel(props: { uri: string }) {
    const [selected, setSelected] = createSignal<string | null>(null);

    /**
     * 视角：只看本任务 / 看全部（"总的 run 管理器"）。
     *
     * 缺省「本任务」：面板挂在任务页底栏，先把**这活儿的**后台活说清楚；
     * 但用户要的"总的 run 管理器"也必须能进 —— 一个按钮切过去，不用换页面。
     */
    const [scope, setScope] = createSignal<"task" | "all">("task");
    const [tab, setTab] = createSignal<Tab>("summary");
    const [tail, setTail] = createSignal<TailView | null>(null);
    const [meta, setMeta] = createSignal<MetaView | null>(null);
    const [detailErr, setDetailErr] = createSignal<string | null>(null);
    const [busy, setBusy] = createSignal(false);
    const [fracSplit, setFracSplit] = createSignal(loadFrac(FRAC_KEY_SPLIT, 0.55));

    let bodyRef: HTMLDivElement | undefined;

    onMount(() => {
        const stop = jobRunsStore.watch();
        onCleanup(stop);
    });

    /**
     * 含前台命令（**缺省开**）：`bash` 不加 `background` 也建一行 —— 否则「`&` 起的孤儿」
     * 只有"未登记"那一行，进程一死就再也说不清是谁起的。关掉只是让表安静些。
     */
    const [showForeground, setShowForeground] = createSignal(true);

    /** 行：先 run（活体在前），再未登记的野进程；「全部」视角下不分任务 */
    const rows = createMemo<Row[]>(() => {
        const all = scope() === "all";
        const runs = (all ? jobRunsStore.allRuns() : jobRunsStore.runsFor(props.uri))
            .filter((run) => showForeground() || !run.foreground)
            .map((run): Row => ({ kind: "run", run }));
        const procs = (all ? jobRunsStore.allUntracked() : jobRunsStore.untrackedFor(props.uri)).map(
            (proc): Row => ({ kind: "proc", proc }),
        );
        return [...runs, ...procs];
    });

    /** 行键（run 用 `r-…`、野进程用 `pid:<n>`）；`null` 行给空串（"没选中"也是一种状态）。 */
    const keyOf = (row: Row | null): string => (row === null ? "" : row.kind === "run" ? row.run.id : row.proc.id);

    /** 默认选中：第一条正在跑的；否则最近一条（打开面板多半就是想看"现在在跑什么"） */
    const activeRow = createMemo<Row | null>(() => {
        const list = rows();
        const sel = selected();
        if (sel) {
            const hit = list.find((r) => keyOf(r) === sel);
            if (hit) return hit;
        }
        return list.find((r) => r.kind === "run" && r.run.state === "running") ?? list[0] ?? null;
    });

    const activeRun = createMemo<RunView | null>(() => {
        const a = activeRow();
        return a && a.kind === "run" ? a.run : null;
    });

    const running = createMemo(() => jobRunsStore.runsFor(props.uri).filter((r) => r.state === "running").length);
    const untrackedCount = createMemo(() => jobRunsStore.untrackedFor(props.uri).length);

    const loadTail = async (id: string): Promise<void> => {
        setBusy(true);
        try {
            const r = await diyService.diy.job.tail({ id, lines: 200 });
            if (r.status !== "ok" || !("data" in r) || !r.data) {
                setDetailErr("取输出失败（这条 run 已不在活体表里）");
                setTail(null);
                return;
            }
            const d = r.data as { text: string; lines: number; droppedBytes: number };
            setTail({ text: d.text, lines: d.lines, droppedBytes: d.droppedBytes, at: Date.now() });
            setDetailErr(null);
        } catch (e) {
            setDetailErr(`取输出失败：${e instanceof Error ? e.message : String(e)}`);
            setTail(null);
        } finally {
            setBusy(false);
        }
    };

    const loadMeta = async (id: string): Promise<void> => {
        try {
            const r = await diyService.diy.job.meta({ id });
            if (r.status !== "ok" || !("data" in r) || !r.data) {
                setMeta(null);
                return;
            }
            const d = r.data as MetaView;
            setMeta({ metaJson: d.metaJson, dir: d.dir, logPath: d.logPath, outputBytes: d.outputBytes });
        } catch {
            setMeta(null);
        }
    };

    /**
     * 选中行/切 tab ⇒ 取该看的那份。
     *
     * 「该看的那份」跟着 tab 走：在「存储数据」tab 上就不白读一次 out.log（反之亦然）。
     * 未登记的进程没有落盘（它压根没走登记），它的 tab 只有「输出 = 无」和「API = 该行」。
     */
    createEffect(
        on(
            () => [keyOf(activeRow()), tab()] as const,
            ([, t]) => {
                const a = activeRow();
                if (!a) {
                    setTail(null);
                    setMeta(null);
                    return;
                }
                if (a.kind !== "run") {
                    setTail(null);
                    setMeta(null);
                    return;
                }
                if (t === "store") void loadMeta(a.run.id);
                else if (t === "output") void loadTail(a.run.id);
            },
        ),
    );

    /** 在跑的 run：每 3s 重取一次输出（看得到输出在长） */
    onMount(() => {
        const t = setInterval(() => {
            const run = activeRun();
            if (!run || run.state !== "running") return;
            if (tab() === "output") void loadTail(run.id);
            else if (tab() === "store") void loadMeta(run.id);
        }, 3000);
        onCleanup(() => clearInterval(t));
    });

    /** 点「来源」：切到该任务会话，并把待定位请求交给会话页（它挂载/切任务时取走） */
    const gotoOrigin = (run: RunView): void => {
        const o = run.origin;
        if (!o) return;
        getRendererActions().openTaskRun?.(o.taskUri);
        // 定位需要 (turnId, blockId) 一对（`JobNavTarget` 的契约）；缺一个就只切页，不假装能定位
        if (o.toolCallId && o.turnId) {
            jobRunsStore.requestNav({ taskUri: o.taskUri, turnId: o.turnId, blockId: o.toolCallId });
        }
    };

    const stopRun = async (run: RunView): Promise<void> => {
        setBusy(true);
        try {
            const r = await diyService.diy.job.kill({ id: run.id });
            if (r.status !== "ok") setDetailErr(("msg" in r ? r.msg : null) ?? "停止失败");
            else setDetailErr(null);
            await jobRunsStore.refresh();
        } catch (e) {
            setDetailErr(`停止失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    /** 结束一条**未登记**的进程（main 侧会重扫 ps 校验，不会误杀别人的） */
    const stopProc = async (proc: ProcRow): Promise<void> => {
        setBusy(true);
        try {
            const r = await diyService.diy.job.killPid({ pid: proc.pid });
            if (r.status !== "ok") setDetailErr(("msg" in r ? r.msg : null) ?? "结束失败");
            else setDetailErr(null);
            await jobRunsStore.refresh();
        } catch (e) {
            setDetailErr(`结束失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    /**
     * 拖分隔条 —— 与 `ViewGrid` 的线同一手感（6px 可见条、hover 高亮、整段 window 监听）。
     *
     * 只有左右一种布局（刀 14 删掉上下布局）：拖的是宽。
     */
    const startResize = (e: MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        const el = bodyRef;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const setter = setFracSplit;
        const getter = fracSplit;
        const key = FRAC_KEY_SPLIT;
        const move = (ev: MouseEvent): void => {
            const f = (ev.clientX - rect.left) / rect.width;
            setter(Math.min(0.85, Math.max(0.15, f)));
        };
        const up = (): void => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            bodyRef?.removeAttribute("data-resizing");
            try {
                localStorage.setItem(key, String(getter()));
            } catch {
                // 记不住就算了：位置只在本次会话里有，不影响功能
            }
        };
        bodyRef?.setAttribute("data-resizing", "x");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    const frac = (): number => fracSplit();

    return (
        <div class="flex h-full min-h-0 flex-col overflow-hidden" data-job-runs-panel data-job-layout="split">
            {/*
              顶栏：右边要摆按钮 ⇒ 右侧必须让位给 area chrome（`AREA_CHROME_W`）。
              这不是"美化"：chrome 是 absolute 浮层、不占布局，原来两边落在同一块像素上（用户报的覆盖）。
            */}
            <div
                class={`flex items-center gap-2 border-b px-3 ${VIEW_BAR_H} shrink-0 text-body`}
                style={{ "padding-right": `${AREA_CHROME_W + 12}px` }}
            >
                <span class="font-medium">作业</span>
                <div class="join shrink-0" data-tip="视角：本任务的后台活 / 这台 app 全部的活（总的 run 管理器）">
                    <button
                        class={`btn btn-xs join-item ${scope() === "task" ? "btn-active" : "btn-ghost"}`}
                        data-job-scope-btn="task"
                        onClick={() => setScope("task")}
                    >
                        本任务
                    </button>
                    <button
                        class={`btn btn-xs join-item ${scope() === "all" ? "btn-active" : "btn-ghost"}`}
                        data-job-scope-btn="all"
                        onClick={() => setScope("all")}
                    >
                        全部
                    </button>
                </div>
                <button
                    class={`btn btn-xs shrink-0 ${showForeground() ? "btn-active" : "btn-ghost"}`}
                    data-job-foreground-btn="toggle"
                    data-tip="前台命令（工具调用正在等它的那种）也列出来。关掉=只看后台活"
                    onClick={() => setShowForeground(!showForeground())}
                >
                    {showForeground() ? "含前台" : "只后台"}
                </button>
                <span class="opacity-60" data-job-count>
                    {rows().length} 条
                    {running() > 0 ? ` · ${running()} 在跑` : ""}
                    {untrackedCount() > 0 ? ` · ${untrackedCount()} 未登记` : ""}
                </span>
                <div class="flex-1" />
                <Show when={jobRunsStore.loading}>
                    <span class="shrink-0 opacity-50">读取中…</span>
                </Show>
                <button
                    class="btn btn-xs btn-ghost shrink-0"
                    data-tip="立刻重读运行表（面板可见时每 3s 自动刷）"
                    onClick={() => void jobRunsStore.refresh()}
                >
                    ↻
                </button>
            </div>

            <Show when={jobRunsStore.error}>
                {(msg) => <div class="px-3 py-2 text-body text-error">{msg()}</div>}
            </Show>

            <div
                ref={(el) => (bodyRef = el)}
                class="flex-1 min-h-0 flex flex-row"
                data-job-body
            >
                {/* ── 表 ── */}
                <div
                    class="min-h-0 min-w-0 overflow-auto"
                    style={{ width: `${frac() * 100}%` }}
                >
                    <Show
                        when={rows().length > 0}
                        fallback={
                            <div class="px-3 py-6 text-body opacity-60" data-job-empty>
                                这个任务还没有后台作业。
                                <div class="mt-1 opacity-70">
                                    让 agent 用 <code class="font-mono">bash</code> 的{" "}
                                    <code class="font-mono">background:true</code> 起一条命令（或命令跑得比 300s 长），
                                    这里就会出现它的状态、耗时、输出与来源；命令里自己{" "}
                                    <code class="font-mono">nohup xxx &</code> 起的进程也会被扫出来（标「未登记」）。
                                </div>
                            </div>
                        }
                    >
                        {/*
                          `table-fixed` 是**必须**的：列多、且底栏通常只有两三百 px 高，
                          不固定列宽时表格会按 min-content 撑开、横向溢出到详情面板底下
                          （实测「来源」按钮被详情的命令行压在下面，点不到）。固定后窄列不缩、
                          宽列（标题）自己截断，任何面板宽度下都不会互相盖住。
                        */}
                        <table class="w-full table-fixed text-xs" data-job-table>
                            <colgroup>
                                <col style="width: 5.4rem" />
                                <col />
                                <col style="width: 5rem" />
                                <col style="width: 3.2rem" />
                                <col style="width: 3.6rem" />
                                <col style="width: 3.4rem" />
                                <col style="width: 4.6rem" />
                                <col style="width: 3.6rem" />
                            </colgroup>
                            <thead class="sticky top-0 z-10 bg-base-100 text-body opacity-70">
                                <tr class="border-b text-left">
                                    <th class="py-1 pl-3 pr-2 font-normal">状态</th>
                                    <th class="px-2 font-normal">标题 / 命令首行</th>
                                    <th class="px-2 font-normal">来源</th>
                                    <th class="px-2 font-normal whitespace-nowrap" data-tip="前台=工具调用正在等结果；后台=background:true 或命令自己 & 起的">
                                        类型
                                    </th>
                                    <th class="px-2 font-normal whitespace-nowrap">时长</th>
                                    <th class="px-2 font-normal whitespace-nowrap">输出</th>
                                    <th class="px-2 font-normal whitespace-nowrap">退出</th>
                                    <th class="px-2 font-normal whitespace-nowrap">pid</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={rows()}>
                                    {(row) => {
                                        const key = keyOf(row);
                                        const isActive = () => keyOf(activeRow()) === key;
                                        const lamp = () => LAMP_CLASS[row.kind === "run" ? row.run.state : "untracked"];
                                        return (
                                            <tr
                                                class={`cursor-pointer border-b border-base-content/10 align-top ${isActive() ? "bg-base-content/10" : "hover:bg-base-content/5"}`}
                                                data-job-row={key}
                                                data-job-kind={row.kind}
                                                data-job-state={row.kind === "run" ? row.run.state : "untracked"}
                                                onClick={() => setSelected(key)}
                                            >
                                                <td class="py-1 pl-3 pr-2 whitespace-nowrap">
                                                    <span class="inline-flex items-center gap-1">
                                                        <span class={`h-2 w-2 shrink-0 rounded-full ${lamp()}`} />
                                                        {row.kind === "run" ? row.run.stateLabel : "未登记"}
                                                    </span>
                                                </td>
                                                <td class="px-2">
                                                    <div
                                                        class="truncate font-medium"
                                                        data-tip={row.kind === "run" ? row.run.command : row.proc.command}
                                                    >
                                                        {row.kind === "run" ? row.run.title : row.proc.title}
                                                    </div>
                                                    <Show when={row.kind === "run" && row.run.error}>
                                                        {(e) => <div class="truncate text-error">{e()}</div>}
                                                    </Show>
                                                    <Show when={row.kind === "run" && row.run.awaitingGroup}>
                                                        <span
                                                            class="mr-1 rounded bg-warning/20 px-1 text-xs"
                                                            data-job-awaiting-group
                                                        >
                                                            后台仍在跑
                                                        </span>
                                                    </Show>
                                                    <Show when={row.kind === "run" && row.run.foreground}>
                                                        <span class="mr-1 rounded bg-base-content/10 px-1 text-xs opacity-70" data-job-foreground>
                                                            前台
                                                        </span>
                                                    </Show>
                                                    <Show when={scope() === "all" && row.kind === "run" && row.run.origin?.taskUri}>
                                                        {(uri) => (
                                                            <div class="truncate opacity-50" data-job-run-task>
                                                                {uri()}
                                                            </div>
                                                        )}
                                                    </Show>
                                                    <Show when={row.kind === "proc"}>
                                                        <div class="truncate opacity-60" data-job-proc-stats>
                                                            {(row as { kind: "proc"; proc: ProcRow }).proc.cpuText} · 内存{" "}
                                                            {(row as { kind: "proc"; proc: ProcRow }).proc.memText} · pgid{" "}
                                                            {(row as { kind: "proc"; proc: ProcRow }).proc.pgid}
                                                        </div>
                                                    </Show>
                                                </td>
                                                <td class="px-2">
                                                    <Show
                                                        when={row.kind === "run" ? row.run.origin?.toolCallId : null}
                                                        fallback={
                                                            <span
                                                                class="opacity-60"
                                                                data-tip={row.kind === "run" ? row.run.originText : row.proc.groupText}
                                                            >
                                                                {row.kind === "proc"
                                                                    ? "未登记"
                                                                    : row.run.origin
                                                                      ? "无锚点"
                                                                      : "—"}
                                                            </span>
                                                        }
                                                    >
                                                        <button
                                                            class="btn btn-xs btn-ghost gap-1 px-1 min-h-0"
                                                            data-job-origin-link={(row as { kind: "run"; run: RunView }).run.origin?.taskUri}
                                                            data-tip={`${(row as { kind: "run"; run: RunView }).run.originText}（点它回会话定位到那次工具调用）`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                gotoOrigin((row as { kind: "run"; run: RunView }).run);
                                                            }}
                                                        >
                                                            ▶ 会话 ↗
                                                        </button>
                                                    </Show>
                                                </td>
                                                <td class="px-2 whitespace-nowrap">
                                                    <span
                                                        class={`rounded px-1 text-xs ${
                                                            row.kind === "proc"
                                                                ? "bg-base-content/10 opacity-70"
                                                                : row.run.background
                                                                  ? "bg-primary/15 text-primary"
                                                                  : "bg-base-content/10 opacity-70"
                                                        }`}
                                                        data-job-mode={row.kind === "run" ? row.run.modeText : "后台"}
                                                    >
                                                        {row.kind === "run" ? row.run.modeText : "后台"}
                                                    </span>
                                                </td>
                                                <td class="px-2 whitespace-nowrap opacity-70">
                                                    {row.kind === "run" ? row.run.durationText : row.proc.elapsedText}
                                                </td>
                                                <td class="px-2 whitespace-nowrap opacity-70">
                                                    {row.kind === "run" ? row.run.outputText : "—"}
                                                </td>
                                                <td class="px-2 whitespace-nowrap opacity-70">
                                                    {row.kind === "run" ? row.run.exitText : "—"}
                                                </td>
                                                <td class="px-2 whitespace-nowrap font-mono opacity-60">
                                                    {row.kind === "run" ? (row.run.pid ?? "—") : row.proc.pid}
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>

                {/* ── 分隔条：可拖（和 ViewGrid 的线同款：6px、hover 高亮、cursor 跟随方向）── */}
                <Show when={activeRow()}>
                    <div
                        class="shrink-0 w-1.5 cursor-col-resize bg-base-content/10 hover:bg-primary/40 active:bg-primary/60"
                        data-job-resizer
                        data-tip="拖动调整列表 / 详情的大小"
                        onMouseDown={startResize}
                    />
                </Show>

                {/* ── 详情 ── */}
                <Show when={activeRow()}>
                    {(row) => (
                        <div
                            class="flex min-h-0 min-w-0 flex-1 flex-col text-body"
                            data-job-detail
                            data-job-detail-id={keyOf(row())}
                        >
                            {/*
                              详情头（刀 14 瘦身）：只留**一行标题 + 停止按钮**。
                              命令行全文、字段表都搬进「概要」tab —— 用户实测：
                              「详细栏不要上下结构了，分成 4 个 tab 都放到一起，不然太占高度了」。
                            */}
                            <div class="flex shrink-0 items-center gap-2 px-3 pt-2">
                                <span
                                    class={`h-2 w-2 shrink-0 rounded-full ${LAMP_CLASS[row().kind === "run" ? (row() as { kind: "run"; run: RunView }).run.state : "untracked"]}`}
                                />
                                <span class="min-w-0 flex-1 truncate font-medium">
                                    {row().kind === "run"
                                        ? (row() as { kind: "run"; run: RunView }).run.title
                                        : (row() as { kind: "proc"; proc: ProcRow }).proc.title}
                                </span>
                                <Show when={row().kind === "run" && (row() as { kind: "run"; run: RunView }).run.state === "running"}>
                                    <button
                                        class="btn btn-xs btn-warning shrink-0"
                                        data-job-stop
                                        onClick={() => void stopRun((row() as { kind: "run"; run: RunView }).run)}
                                    >
                                        停止
                                    </button>
                                </Show>
                                <Show when={row().kind === "proc"}>
                                    <button
                                        class="btn btn-xs btn-warning shrink-0"
                                        data-job-kill-pid={(row() as { kind: "proc"; proc: ProcRow }).proc.pid}
                                        data-tip="结束这条进程（按进程组；main 侧会重扫 ps 校验它确实归我们管）"
                                        onClick={() => void stopProc((row() as { kind: "proc"; proc: ProcRow }).proc)}
                                    >
                                        结束进程
                                    </button>
                                </Show>
                            </div>

                            {/* tab 条：未登记的进程没有落盘，只有"输出（无）"与"API 数据"两页有内容 */}
                            <div class="flex shrink-0 items-center gap-1 border-b px-2" data-job-tabs>
                                <For
                                    each={
                                        [
                                            ["summary", "概要"],
                                            ["output", "输出"],
                                            ["api", "API 数据"],
                                            ["store", "存储数据"],
                                        ] as Array<[Tab, string]>
                                    }
                                >
                                    {([key, label]) => (
                                        <button
                                            class={`btn btn-xs ${tab() === key ? "btn-active" : "btn-ghost"}`}
                                            data-job-tab={key}
                                            onClick={() => setTab(key)}
                                        >
                                            {label}
                                        </button>
                                    )}
                                </For>
                                <div class="flex-1" />
                                <Show when={busy()}>
                                    <span class="opacity-50">读取中…</span>
                                </Show>
                            </div>

                            <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
                                <Show when={detailErr()}>{(m) => <div class="text-xs text-error">{m()}</div>}</Show>

                                {/*
                                  概要（刀 14）：**后台进程的关键属性都在这页**——
                                  用户实测「默认的详情 tab 里缺少后台进程的关键属性」。
                                  命令行原文 + 类型（前台/后台）+ 进程组 + 名下进程 + 来源锚点 + 通知状态。
                                */}
                                <Show when={tab() === "summary"}>
                                    <pre
                                        class="mb-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-base-200/50 p-2 font-mono text-xs opacity-90"
                                        data-job-command
                                    >
                                        {row().kind === "run"
                                            ? (row() as { kind: "run"; run: RunView }).run.command
                                            : (row() as { kind: "proc"; proc: ProcRow }).proc.command}
                                    </pre>
                                    <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                                        <Show when={row().kind === "run"} fallback={<ProcFields proc={(row() as { kind: "proc"; proc: ProcRow }).proc} />}>
                                            <RunFields run={(row() as { kind: "run"; run: RunView }).run} />
                                            <Show when={tail()?.droppedBytes}>
                                                {(n) => (
                                                    <>
                                                        <span class="opacity-60">输出截断</span>
                                                        <span class="text-warning">{n()}B（底部只留最近一段）</span>
                                                    </>
                                                )}
                                            </Show>
                                            <Show when={jobRunsStore.procsOfRun((row() as { kind: "run"; run: RunView }).run.id).length > 0}>
                                                <span class="opacity-60">名下进程</span>
                                                <span class="font-mono opacity-80" data-job-run-procs>
                                                    <For each={jobRunsStore.procsOfRun((row() as { kind: "run"; run: RunView }).run.id)}>
                                                        {(p) => (
                                                            <div class="truncate">
                                                                {p.pid} · {p.cpuText} · {p.memText} · {p.title}
                                                            </div>
                                                        )}
                                                    </For>
                                                </span>
                                            </Show>
                                        </Show>
                                    </div>
                                </Show>

                                {/* 输出：out.log 的尾部（选中才读一次；在跑每 3s 重读） */}
                                <Show when={tab() === "output"}>
                                    <Show
                                        when={row().kind === "run"}
                                        fallback={
                                            <div class="text-xs opacity-60" data-job-tail-empty>
                                                这条进程没走调度器（命令里自己 <code class="font-mono">&</code> 起的），
                                                所以它没有我们的输出文件；要看输出请回到起它的那条命令。
                                            </div>
                                        }
                                    >
                                        <Show
                                            when={tail()?.text}
                                            fallback={
                                                <div class="text-xs opacity-60" data-job-tail-empty>
                                                    （还没有输出）
                                                </div>
                                            }
                                        >
                                            {(text) => (
                                                <pre
                                                    class="whitespace-pre-wrap break-all font-mono text-xs opacity-90"
                                                    data-job-tail
                                                >
                                                    {text()}
                                                </pre>
                                            )}
                                        </Show>
                                    </Show>
                                </Show>

                                {/* API 数据：这条记录在 `diy job ps` 里的**原始载荷**（就是这个对象） */}
                                <Show when={tab() === "api"}>
                                    <pre
                                        class="whitespace-pre-wrap break-all font-mono text-xs opacity-90"
                                        data-job-api-json
                                    >
                                        {JSON.stringify(row().kind === "run" ? (row() as { kind: "run"; run: RunView }).run : (row() as { kind: "proc"; proc: ProcRow }).proc, null, 2)}
                                    </pre>
                                </Show>

                                {/* 存储数据：落盘的 meta.json 原文 + 两条路径（"到底存了什么"） */}
                                <Show when={tab() === "store"}>
                                    <Show
                                        when={row().kind === "run"}
                                        fallback={
                                            <div class="text-xs opacity-60">
                                                未登记的进程没有落盘（它从没走过 <code class="font-mono">run-registry</code>）。
                                                它的全部信息就是上面那个 API 对象里的 pid / 命令行 / 进程组。
                                            </div>
                                        }
                                    >
                                        {(() => {
                                            const run = (row() as { kind: "run"; run: RunView }).run;
                                            return (
                                                <div class="text-xs">
                                                    <div class="opacity-60">目录</div>
                                                    <div class="truncate font-mono opacity-90" data-job-dir>
                                                        {meta()?.dir ?? run.dir}
                                                    </div>
                                                    <div class="mt-1 opacity-60">输出日志</div>
                                                    <div class="truncate font-mono opacity-90" data-job-log-path>
                                                        {meta()?.logPath ?? run.logPath}
                                                        <span class="opacity-60">
                                                            {" "}
                                                            （{bytesText(meta()?.outputBytes ?? run.outputBytes ?? 0)}）
                                                        </span>
                                                    </div>
                                                    <div class="mt-1 opacity-60">meta.json</div>
                                                    <Show
                                                        when={meta()?.metaJson}
                                                        fallback={<div class="opacity-50">（读不到 meta.json）</div>}
                                                    >
                                                        {(json) => (
                                                            <pre
                                                                class="whitespace-pre-wrap break-all font-mono text-xs opacity-90"
                                                                data-job-meta-json
                                                            >
                                                                {json()}
                                                            </pre>
                                                        )}
                                                    </Show>
                                                </div>
                                            );
                                        })()}
                                    </Show>
                                </Show>
                            </div>
                        </div>
                    )}
                </Show>
            </div>
        </div>
    );
}

/** run 的字段行（`grid-cols-[auto_1fr]` 的子项） */
function RunFields(props: { run: RunView }) {
    return (
        <>
            <span class="opacity-60">run</span>
            <span class="truncate font-mono">{props.run.id}</span>
            <span class="opacity-60">状态</span>
            <span>
                {props.run.stateLabel} · {props.run.exitText}
                <Show when={props.run.signal}>{(s) => <span class="opacity-60"> · 信号 {s()}</span>}</Show>
            </span>
            <span class="opacity-60">时间</span>
            <span class="opacity-80">
                {props.run.startedAtText}
                {props.run.endedAtText ? ` → ${props.run.endedAtText}` : ""} · 共 {props.run.durationText}
            </span>
            <span class="opacity-60">类型</span>
            <span class="opacity-80" data-job-field="mode">
                {props.run.modeText}
                <Show when={props.run.background}>
                    <span class="ml-1 opacity-60">（background:true，工具已返回，结束会叫醒 agent）</span>
                </Show>
                <Show when={props.run.foreground}>
                    <span class="ml-1 opacity-60">（工具调用在等它的结果；普通命令不叫醒 agent）</span>
                </Show>
            </span>
            <Show when={props.run.hadSurvivingGroup || props.run.awaitingGroup}>
                <span class="opacity-60">后台子孙</span>
                <span class="opacity-80" data-job-field="surviving">
                    <Show when={props.run.awaitingGroup} fallback="曾经有过后台进程（已全部结束）">
                        <span class="text-warning">仍在跑</span>
                        <span class="opacity-60"> —— 根命令已退，这条 run 还没结束</span>
                    </Show>
                </span>
            </Show>
            <span class="opacity-60">pid</span>
            <span class="font-mono opacity-80">
                {props.run.pid ?? "—（进程内任务）"}
                <Show when={props.run.pgid}>
                    {(pg) => <span class="opacity-60"> · 进程组 {pg()}</span>}
                </Show>
            </span>
            <span class="opacity-60">cwd</span>
            <span class="truncate font-mono opacity-80" data-tip={props.run.cwd}>
                {props.run.cwd}
            </span>
            <span class="opacity-60">来源</span>
            <span class="truncate opacity-80" data-tip="origin：哪个任务 / 轮 / 步 / 工具调用起的">
                {props.run.originText}
            </span>
            <span class="opacity-60">输出</span>
            <span class="opacity-80">
                {props.run.outputText}
            </span>
            <span class="opacity-60">通知</span>
            <span class="opacity-80" data-job-field="notified">
                {props.run.notified ? "已叫醒 agent" : props.run.state === "running" ? "结束后会叫醒（若为后台）" : "未投递（我们杀的 / 无来源锚点）"}
            </span>
        </>
    );
}

/** 未登记进程的字段行 */
function ProcFields(props: { proc: ProcRow }) {
    return (
        <>
            <span class="opacity-60">pid</span>
            <span class="font-mono">{props.proc.pid}</span>
            <span class="opacity-60">进程组</span>
            <span class="font-mono opacity-80">
                {props.proc.pgid} · 父 {props.proc.ppid}
            </span>
            <span class="opacity-60">已运行</span>
            <span class="opacity-80">{props.proc.elapsedText}</span>
            <span class="opacity-60">CPU / 内存</span>
            <span class="opacity-80">
                {props.proc.cpuText} · {props.proc.memText}
            </span>
            <span class="opacity-60">来源</span>
            <span class="truncate opacity-80" data-tip={props.proc.groupCommand ?? "未知"}>
                {props.proc.groupText}
            </span>
            <span class="opacity-60">说明</span>
            <span class="opacity-70">
                没走调度器（命令里自己 <code class="font-mono">&</code> / <code class="font-mono">nohup</code> 起的），
                只能看和杀，没有输出与账。
            </span>
        </>
    );
}
