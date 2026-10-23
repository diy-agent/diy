/**
 * JobRunsPanel — 任务页底栏的「作业」面板（##408；刀 9 改成**运行表 + 三 tab 详情**）。
 *
 * 用户 2026-10-23 的口径（本刀唯一依据）：
 *   「先开发页面，不然不知道是怎么运转的，**把原始命令行要显示出来**。表格形式，各种字段。」
 *   +「每条记录加个按钮，可以看原文数据的（实际存储和 `diy job show` 的数据），
 *      和输出用 tab 分开看切换，即详情分 输出 / API 数据 / 存储数据」
 *   +「右上角的几个按钮排列有问题有覆盖现象（最大化 / 最小化 / 刷新）」
 *
 * ── 四个刻意的克制 ──
 *   ① **数据源只有一个**：`diy.job.ps` / `job.tail` / `job.meta`（= main 侧活体表 + run 自己的落盘）。
 *      面板不新造存储、不猜状态。
 *   ② **表格给字段，详情给原文**：表格列只放"扫一眼要看"的（状态 / 标题 / 时长 / 输出量 /
 *      退出 / 来源 / 启动）；原始命令行全文、pid、cwd、两条落盘路径都进详情 —— 否则表格会被
 *      一条长命令撑成三行高。
 *   ③ **不给每行都拉 tail**：`job.tail` 读一次 out.log。列表只显示字节数（`job.ps` 已 stat），
 *      **选中哪行才**去取它的输出（一次请求）。
 *   ④ **右内边距留给 area chrome**：本面板顶栏右侧有按钮，而 chrome 是 `absolute right-0`
 *      不占布局的浮层 ⇒ 必须显式让位（`AREA_CHROME_W`），否则两边盖在一起（用户报的那个 bug）。
 *
 * ── 为什么是「表格 + 选中行详情」而不是每行展开 ──
 *   运行表可能几十条（一次会话里每起一条后台命令就是一行）。行内展开会让列表每点一次整体位移，
 *   读起来更累；详情固定在一侧（或下侧），滚动列表时不会跟着跑。
 */

import { createSignal, createMemo, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { jobRunsStore } from "../store/jobRunsStore";
import { AREA_CHROME_W, VIEW_BAR_H } from "../lib/layout-metrics";
import type { RunView } from "../../shared/run-view";
import { bytesText } from "../../shared/run-view";

/** 灯 → class（颜色归主题；这里只选 token，不写具体色值） */
const LAMP_CLASS: Record<string, string> = {
    running: "bg-info",
    exited: "bg-success",
    killed: "bg-warning",
    failed: "bg-error",
};

function lampClassOf(row: RunView): string {
    return LAMP_CLASS[row.state] ?? "bg-base-content/40";
}

/** 详情 tab */
type Tab = "output" | "api" | "store";

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

/** 布局：左右（列表 ↔ 详情）或上下（列表 ↑ 详情） */
type LayoutMode = "split" | "stack";

export function JobRunsPanel(props: { uri: string }) {
    const [selected, setSelected] = createSignal<string | null>(null);
    const [mode, setMode] = createSignal<LayoutMode>("split");
    const [tab, setTab] = createSignal<Tab>("output");
    const [tail, setTail] = createSignal<TailView | null>(null);
    const [meta, setMeta] = createSignal<MetaView | null>(null);
    const [detailErr, setDetailErr] = createSignal<string | null>(null);
    const [busy, setBusy] = createSignal(false);

    onMount(() => {
        const stop = jobRunsStore.watch();
        onCleanup(stop);
    });

    const rows = createMemo(() => jobRunsStore.runsFor(props.uri));

    /** 默认选中：第一条正在跑的；否则最近一条（打开面板多半就是想看"现在在跑什么"） */
    const activeRow = createMemo<RunView | null>(() => {
        const list = rows();
        const sel = selected();
        if (sel) {
            const hit = list.find((r) => r.id === sel);
            if (hit) return hit;
        }
        return list.find((r) => r.state === "running") ?? list[0] ?? null;
    });

    const running = createMemo(() => rows().filter((r) => r.state === "running").length);

    const loadTail = async (row: RunView): Promise<void> => {
        setBusy(true);
        try {
            const r = await diyService.diy.job.tail({ id: row.id, lines: 200 });
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

    const loadMeta = async (row: RunView): Promise<void> => {
        try {
            const r = await diyService.diy.job.meta({ id: row.id });
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
     * 选中行变了 ⇒ 取该看的那份。
     *
     * 「该看的那份」跟着 tab 走：在「存储数据」tab 上就不要白读一次 out.log（反过来也一样）——
     * 用户切 tab 才是意图，别替他预取两份。
     */
    createEffect(
        on(
            () => [activeRow()?.id ?? null, tab()] as const,
            ([id]) => {
                const row = activeRow();
                if (!id || !row) {
                    setTail(null);
                    setMeta(null);
                    return;
                }
                if (tab() === "store") void loadMeta(row);
                else if (tab() === "output") void loadTail(row);
            },
        ),
    );

    /** 在跑的 run：每 3s 重取一次输出（与列表同一个节奏，看得到输出在长） */
    onMount(() => {
        const t = setInterval(() => {
            const row = activeRow();
            if (!row || row.state !== "running") return;
            if (tab() === "output") void loadTail(row);
            else if (tab() === "store") void loadMeta(row);
        }, 3000);
        onCleanup(() => clearInterval(t));
    });

    /** 点「来源」：切到该任务会话，并把待定位请求交给会话页（它挂载/切任务时取走） */
    const gotoOrigin = (row: RunView): void => {
        const o = row.origin;
        if (!o) return;
        getRendererActions().openTaskRun?.(o.taskUri);
        // 定位需要 (turnId, blockId) 一对（`JobNavTarget` 的契约）；缺一个就只切页，不假装能定位
        if (o.toolCallId && o.turnId) {
            jobRunsStore.requestNav({ taskUri: o.taskUri, turnId: o.turnId, blockId: o.toolCallId });
        }
    };

    const stop = async (row: RunView): Promise<void> => {
        setBusy(true);
        try {
            const r = await diyService.diy.job.kill({ id: row.id });
            if (r.status !== "ok") setDetailErr(("msg" in r ? r.msg : null) ?? "停止失败");
            else setDetailErr(null);
            await jobRunsStore.refresh();
        } catch (e) {
            setDetailErr(`停止失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div class="flex h-full min-h-0 flex-col overflow-hidden" data-job-runs-panel data-job-layout={mode()}>
            {/*
              顶栏：右边要摆按钮 ⇒ 右侧必须让位给 area chrome（`AREA_CHROME_W`）。
              这不是"美化"：chrome 是 absolute 浮层、不占布局，原来两边落在同一块像素上（用户报的覆盖）。
            */}
            <div
                class={`flex items-center gap-2 border-b px-3 ${VIEW_BAR_H} shrink-0 text-body`}
                style={{ "padding-right": `${AREA_CHROME_W + 12}px` }}
            >
                <span class="font-medium">作业</span>
                <span class="opacity-60" data-job-count>
                    {rows().length} 条
                    {running() > 0 ? ` · ${running()} 在跑` : ""}
                </span>
                <div class="flex-1" />
                <Show when={jobRunsStore.loading}>
                    <span class="shrink-0 opacity-50">读取中…</span>
                </Show>
                <div class="join shrink-0" data-tip="布局：左右（列表 ↔ 详情）/ 上下（列表 ↑ 详情）">
                    <button
                        class={`btn btn-xs join-item ${mode() === "split" ? "btn-active" : "btn-ghost"}`}
                        data-job-layout-btn="split"
                        onClick={() => setMode("split")}
                    >
                        ⇆ 左右
                    </button>
                    <button
                        class={`btn btn-xs join-item ${mode() === "stack" ? "btn-active" : "btn-ghost"}`}
                        data-job-layout-btn="stack"
                        onClick={() => setMode("stack")}
                    >
                        ⇅ 上下
                    </button>
                </div>
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

            <div class={`flex-1 min-h-0 ${mode() === "split" ? "flex flex-row" : "flex flex-col"}`}>
                {/* ── 表 ── */}
                <div class="min-h-0 min-w-0 flex-1 overflow-auto">
                    <Show
                        when={rows().length > 0}
                        fallback={
                            <div class="px-3 py-6 text-body opacity-60" data-job-empty>
                                这个任务还没有后台作业。
                                <div class="mt-1 opacity-70">
                                    让 agent 用 <code class="font-mono">bash</code> 的{" "}
                                    <code class="font-mono">background:true</code> 起一条命令（或命令跑得比 300s 长），
                                    这里就会出现它的状态、耗时、输出与来源。
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
                                <col style="width: 5.2rem" />
                                <col />
                                <col style="width: 5.4rem" />
                                <col style="width: 3.6rem" />
                                <col style="width: 3.4rem" />
                                <col style="width: 5rem" />
                                <col style="width: 4.2rem" />
                                <col style="width: 3.6rem" />
                            </colgroup>
                            <thead class="sticky top-0 z-10 bg-base-100 text-body opacity-70">
                                <tr class="border-b text-left">
                                    <th class="py-1 pl-3 pr-2 font-normal">状态</th>
                                    <th class="px-2 font-normal">标题 / 命令首行</th>
                                    <th class="px-2 font-normal">来源</th>
                                    <th class="px-2 font-normal whitespace-nowrap">时长</th>
                                    <th class="px-2 font-normal whitespace-nowrap">输出</th>
                                    <th class="px-2 font-normal whitespace-nowrap">退出</th>
                                    <th class="px-2 font-normal whitespace-nowrap">启动</th>
                                    <th class="px-2 font-normal whitespace-nowrap">pid</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={rows()}>
                                    {(row) => {
                                        const isActive = () => activeRow()?.id === row.id;
                                        return (
                                            <tr
                                                class={`cursor-pointer border-b border-base-content/10 align-top ${isActive() ? "bg-base-content/10" : "hover:bg-base-content/5"}`}
                                                data-job-row={row.id}
                                                data-job-state={row.state}
                                                onClick={() => setSelected(row.id)}
                                            >
                                                <td class="py-1 pl-3 pr-2 whitespace-nowrap">
                                                    <span class="inline-flex items-center gap-1">
                                                        <span class={`h-2 w-2 shrink-0 rounded-full ${lampClassOf(row)}`} />
                                                        {row.stateLabel}
                                                    </span>
                                                </td>
                                                <td class="px-2">
                                                    <div class="truncate font-medium" data-tip={row.command}>
                                                        {row.title}
                                                    </div>
                                                    <Show when={row.error}>
                                                        {(e) => <div class="truncate text-error">{e()}</div>}
                                                    </Show>
                                                </td>
                                                <td class="px-2">
                                                    <Show
                                                        when={row.origin?.toolCallId}
                                                        fallback={
                                                            <span class="opacity-60" data-tip={row.originText}>
                                                                {row.origin ? "无锚点" : "—"}
                                                            </span>
                                                        }
                                                    >
                                                        <button
                                                            class="btn btn-xs btn-ghost gap-1 px-1 min-h-0"
                                                            data-job-origin-link={row.origin?.taskUri}
                                                            data-tip={`${row.originText}（点它回会话定位到那次工具调用）`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                gotoOrigin(row);
                                                            }}
                                                        >
                                                            ▶ 会话 ↗
                                                        </button>
                                                    </Show>
                                                </td>
                                                <td class="px-2 whitespace-nowrap opacity-70">{row.durationText}</td>
                                                <td class="px-2 whitespace-nowrap opacity-70">{row.outputText}</td>
                                                <td class="px-2 whitespace-nowrap opacity-70">{row.exitText}</td>
                                                <td class="px-2 whitespace-nowrap opacity-60">{row.startedAtText}</td>
                                                <td class="px-2 whitespace-nowrap font-mono opacity-60">
                                                    {row.pid ?? "—"}
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>

                {/* ── 详情 ── */}
                <Show when={activeRow()}>
                    {(row) => (
                        <div
                            class={`flex min-h-0 min-w-0 flex-col text-body ${
                                mode() === "split" ? "w-[46%] min-w-[280px] border-l" : "h-[46%] min-h-[160px] border-t"
                            }`}
                            data-job-detail
                            data-job-detail-id={row().id}
                        >
                            {/* 详情头：标题 + 原始命令行（用户点名要看全文）*/}
                            <div class="shrink-0 px-3 pt-2">
                                <div class="flex items-center gap-2">
                                    <span class={`h-2 w-2 shrink-0 rounded-full ${lampClassOf(row())}`} />
                                    <span class="min-w-0 flex-1 truncate font-medium">{row().title}</span>
                                    <Show when={row().state === "running"}>
                                        <button
                                            class="btn btn-xs btn-warning shrink-0"
                                            data-job-stop
                                            onClick={() => void stop(row())}
                                        >
                                            停止
                                        </button>
                                    </Show>
                                </div>
                                <pre
                                    class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-base-200/50 p-2 font-mono text-xs opacity-90"
                                    data-job-command
                                >
                                    {row().command}
                                </pre>
                            </div>

                            {/* 字段表：表格里放不下的都在这儿 */}
                            <div class="grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
                                <span class="opacity-60">run</span>
                                <span class="truncate font-mono">{row().id}</span>
                                <span class="opacity-60">状态</span>
                                <span>
                                    {row().stateLabel} · {row().exitText}
                                    <Show when={row().signal}>{(s) => <span class="opacity-60"> · 信号 {s()}</span>}</Show>
                                </span>
                                <span class="opacity-60">时间</span>
                                <span class="opacity-80">
                                    {row().startedAtText}
                                    {row().endedAtText ? ` → ${row().endedAtText}` : ""} · 共 {row().durationText}
                                </span>
                                <span class="opacity-60">pid</span>
                                <span class="font-mono opacity-80">{row().pid ?? "—（进程内任务）"}</span>
                                <span class="opacity-60">cwd</span>
                                <span class="truncate font-mono opacity-80" data-tip={row().cwd}>
                                    {row().cwd}
                                </span>
                                <span class="opacity-60">来源</span>
                                <span class="truncate opacity-80" data-tip="origin：哪个任务 / 轮 / 步 / 工具调用起的">
                                    {row().originText}
                                </span>
                                <span class="opacity-60">输出</span>
                                <span class="opacity-80">
                                    {row().outputText}
                                    <Show when={tail()?.droppedBytes}>{(n) => <span class="text-warning"> · 截断 {n()}B</span>}</Show>
                                </span>
                            </div>

                            {/* tab 条 */}
                            <div class="flex shrink-0 items-center gap-1 border-b px-2" data-job-tabs>
                                <For
                                    each={
                                        [
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

                                {/* 输出：out.log 的尾部（选中才读一次；在跑每 3s 重读） */}
                                <Show when={tab() === "output"}>
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

                                {/* API 数据：这条 run 在 `diy job ps` 里的**原始载荷**（就是这个对象） */}
                                <Show when={tab() === "api"}>
                                    <pre
                                        class="whitespace-pre-wrap break-all font-mono text-xs opacity-90"
                                        data-job-api-json
                                    >
                                        {JSON.stringify(row(), null, 2)}
                                    </pre>
                                </Show>

                                {/* 存储数据：落盘的 meta.json 原文 + 两条路径（"到底存了什么"） */}
                                <Show when={tab() === "store"}>
                                    <div class="text-xs">
                                        <div class="opacity-60">目录</div>
                                        <div class="truncate font-mono opacity-90" data-job-dir>
                                            {meta()?.dir ?? row().dir}
                                        </div>
                                        <div class="mt-1 opacity-60">输出日志</div>
                                        <div class="truncate font-mono opacity-90" data-job-log-path>
                                            {meta()?.logPath ?? row().logPath}
                                            <span class="opacity-60">
                                                {" "}
                                                （{bytesText(meta()?.outputBytes ?? row().outputBytes ?? 0)}）
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
                                </Show>
                            </div>
                        </div>
                    )}
                </Show>
            </div>
        </div>
    );
}
