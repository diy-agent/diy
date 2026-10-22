/**
 * JobRunsPanel — 任务执行页底栏的「作业」面板（##408 刀 6）。
 *
 * 这是 v1 的**用户面**：会话里跑出来的长时命令（spawned job）到底有什么、跑成什么样、从哪儿来的，
 * 以及**点一下回到源头那一步 tool_call**（用户 20:5x 点名的那条需求）。
 *
 * ── 三个刻意的克制 ──
 *   ① **不新造存储**：数据只来自 `diy.job.ls` / `diy.job.show`（= 已落盘的执行账 + 进程内活体）。
 *   ② **不给每行都拉 tail**：`job.show` 会读一次 `logs/<runId>.log`，N 行 = N 次读盘。
 *      列表先给 `summary`（账上的一句话结果），**选中哪行才**去取它的输出尾部（一次请求）。
 *   ③ **指不回去就不显示成可点**：`originBadgeOf(...).navigable === false` 时来源那格渲染成
 *      纯文本 + `·` 前缀，不摆按钮（用户原话：别假装能跳）。判据在 `shared/job-runs-view.ts`。
 *
 * ── 为什么是「列表 + 选中行详情」而不是每行展开 ──
 *   长时命令通常就 1~3 条，一屏放得下；详情固定在下面一条带里，滚动列表时不会跟着跑
 *   （行内展开会让列表每点一次就整体位移，读起来更累）。
 */

import { createSignal, createMemo, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { jobRunsStore } from "../store/jobRunsStore";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { fmtBytes } from "../../shared/spawned-job";
import {
    lastLineOf,
    originBadgeOf,
    rowsOfTask,
    stateBadgeOf,
    whenTextOf,
    type RunRow,
} from "../../shared/job-runs-view";

/** 灯 → class（颜色归主题；这里只选 token，不写具体色值） */
const LAMP_CLASS: Record<string, string> = {
    running: "bg-info",
    ok: "bg-success",
    warn: "bg-warning",
    error: "bg-error",
    lost: "bg-base-content/40",
};

function lampClassOf(row: RunRow): string {
    return LAMP_CLASS[stateBadgeOf(row).tone] ?? "bg-base-content/40";
}

interface RunDetail {
    /** 末行输出摘要（「进度探针」的真相在尾部） */
    tailLine: string;
    /** settle 日志尾部全文（选中才取，见文件头 ②） */
    tail: string;
    logPath: string | null;
    /** 环丢掉多少（>0 = 上面的 tail 不是全量） */
    droppedBytes: number;
    /** live 视角的已产出字节（在跑时才有意义） */
    liveBytes: number | null;
}

export function JobRunsPanel(props: { uri: string }) {
    const [selected, setSelected] = createSignal<string | null>(null);
    const [detail, setDetail] = createSignal<RunDetail | null>(null);
    const [detailErr, setDetailErr] = createSignal<string | null>(null);
    const [detailBusy, setDetailBusy] = createSignal(false);

    onMount(() => {
        const stop = jobRunsStore.watch();
        onCleanup(stop);
    });

    const rows = createMemo(() => rowsOfTask(jobRunsStore.snapshot.runs, jobRunsStore.snapshot.live, props.uri));

    /** 默认选中：第一条正在跑的；否则最近一条（用户打开面板多半就是为了看"现在在跑什么"） */
    const activeRow = createMemo<RunRow | null>(() => {
        const list = rows();
        const sel = selected();
        if (sel) {
            const hit = list.find((r) => r.runId === sel);
            if (hit) return hit;
        }
        return list.find((r) => r.state === "running") ?? list[0] ?? null;
    });

    /** 选中行的详情（每次换行重新取一次 `job.show`） */
    const loadDetail = async (row: RunRow): Promise<void> => {
        setDetailBusy(true);
        try {
            const r = await diyService.diy.job.show({ id: row.runId, sample: false, tail: 16 * 1024 });
            if (r.status !== "ok") {
                setDetailErr("取详情失败（这条 run 找不到）");
                setDetail(null);
                return;
            }
            const d = ("data" in r ? r.data : null) as {
                live: { liveText: string; settleText: string; frozen: boolean } | null;
                logTail: string | null;
                logPath: string | null;
                current: { summary?: string } | null;
            };
            // 取哪个视角：在跑看 live（实时），收口看 settle（环的快照）
            const text = d.live && !d.live.frozen ? d.live.liveText : (d.live?.settleText ?? d.logTail ?? "");
            setDetail({
                tailLine: lastLineOf(text),
                tail: text.length > 4000 ? `…（前 ${fmtBytes(text.length - 4000)} 已截断）\n${text.slice(-4000)}` : text,
                logPath: d.logPath,
                droppedBytes: row.live?.output.droppedBytes ?? 0,
                liveBytes: row.live ? row.live.output.totalBytes : null,
            });
            setDetailErr(null);
        } catch (e) {
            setDetailErr(`取详情失败：${e instanceof Error ? e.message : String(e)}`);
            setDetail(null);
        } finally {
            setDetailBusy(false);
        }
    };

    const selectRow = (row: RunRow): void => {
        setSelected(row.runId);
    };

    /**
     * 选中行的详情**自动跟着走**（用户不必先点一下才看到输出）。
     *
     * 两件触发：① 选中行变了（含首次默认选中 = 最近一条 / 正在跑的那条）；
     * ② 该行还在跑 ⇒ 每 3s 重取一次（与列表同一个节奏，看得到输出在长）。
     * 收口（终态）后不再重取：settle 快照不会再变，重复读只是白扫一次盘。
     */
    createEffect(
        on(
            () => activeRow()?.runId ?? null,
            (runId) => {
                const row = activeRow();
                if (!runId || !row) {
                    setDetail(null);
                    return;
                }
                void loadDetail(row);
            },
        ),
    );
    onMount(() => {
        const t = setInterval(() => {
            const row = activeRow();
            if (row && row.state === "running") void loadDetail(row);
        }, 3000);
        onCleanup(() => clearInterval(t));
    });

    /** 点「来源」：切到该任务会话，并把待定位请求交给会话页（它挂载/切任务时取走） */
    const gotoOrigin = (row: RunRow): void => {
        const badge = originBadgeOf(row.origin);
        if (!badge.navigable || row.origin.type !== "spawned") return;
        const d = row.origin.data;
        getRendererActions().openTaskRun?.(d.taskUri);
        jobRunsStore.requestNav({ taskUri: d.taskUri, turnId: d.turnId, blockId: d.toolCallId });
    };

    const running = createMemo(() => rows().filter((r) => r.state === "running").length);

    return (
        <div class="flex h-full min-h-0 flex-col overflow-hidden" data-job-runs-panel>
            {/* 视图栏 = 面板级信息（数量 / 刷新）；不摆"打开设置"之类（面板只读） */}
            <div class={`flex items-center gap-2 border-b px-3 ${VIEW_BAR_H} shrink-0 text-body`}>
                <span class="font-medium">作业</span>
                <span class="opacity-60">
                    {rows().length} 次运行
                    {running() > 0 ? ` · ${running()} 在跑` : ""}
                </span>
                <Show when={jobRunsStore.snapshot.skippedRows > 0}>
                    <span class="text-warning" data-tip="账本里有无法解析的行（观测数据可腐烂）；列表跳过了它们">
                        ⚠ {jobRunsStore.snapshot.skippedRows} 行读不动
                    </span>
                </Show>
                <div class="flex-1" />
                <Show when={jobRunsStore.loading}>
                    <span class="opacity-50">读取中…</span>
                </Show>
                <button
                    class="btn btn-xs btn-ghost shrink-0"
                    data-tip="重新读取执行账（面板可见时每 3s 自动刷）"
                    onClick={() => void jobRunsStore.refresh()}
                >
                    ↻
                </button>
            </div>

            <Show when={jobRunsStore.error}>
                {(msg) => <div class="px-3 py-2 text-body text-error">{msg()}</div>}
            </Show>

            {/* 列表 */}
            <div class="flex-1 min-h-0 overflow-y-auto">
                <Show
                    when={rows().length > 0}
                    fallback={
                        <div class="px-3 py-6 text-body opacity-60" data-job-empty>
                            这个任务还没有长时作业。
                            <div class="mt-1 opacity-70">
                                跑超过 10 秒的命令（构建 / 测试 / 下载）会登记成一条作业，在这里能看到状态、耗时与来源。
                            </div>
                        </div>
                    }
                >
                    <For each={rows()}>
                        {(row) => {
                            const badge = originBadgeOf(row.origin);
                            const st = stateBadgeOf(row);
                            const isActive = () => activeRow()?.runId === row.runId;
                            return (
                                <div
                                    class={`flex items-start gap-2 border-b border-base-content/10 px-3 py-1.5 text-body cursor-pointer ${isActive() ? "bg-base-content/10" : "hover:bg-base-content/5"}`}
                                    data-job-row={row.runId}
                                    data-job-state={row.state}
                                    onClick={() => selectRow(row)}
                                >
                                    <span
                                        class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${lampClassOf(row)}`}
                                        data-tip={st.hint}
                                    />
                                    <div class="min-w-0 flex-1">
                                        <div class="flex items-center gap-2">
                                            <span class="truncate font-medium">{row.title}</span>
                                            {/* 来源：可导航 = 按钮；不可导航 = 纯文本（见文件头 ③） */}
                                            <Show
                                                when={badge.navigable}
                                                fallback={
                                                    <span
                                                        class="shrink-0 opacity-60"
                                                        data-job-origin-static={row.origin.type}
                                                        data-tip={badge.hint}
                                                    >
                                                        {badge.icon} {badge.short}
                                                    </span>
                                                }
                                            >
                                                <button
                                                    class="btn btn-xs btn-ghost gap-1 shrink-0 px-1 min-h-0"
                                                    data-job-origin-link={row.origin.type}
                                                    data-tip={badge.hint}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        gotoOrigin(row);
                                                    }}
                                                >
                                                    {badge.icon} {badge.short} ↗
                                                </button>
                                            </Show>
                                            <span class="shrink-0 opacity-70" data-tip={st.hint}>
                                                {st.text}
                                            </span>
                                            <span class="shrink-0 opacity-50">{whenTextOf(row)}</span>
                                            <Show when={!row.promoted}>
                                                <span class="shrink-0 opacity-50" data-tip="还在阈值之下或没有输出：账本里还没有它，只在内存可见">
                                                    未落账
                                                </span>
                                            </Show>
                                        </div>
                                        <Show when={row.summary}>
                                            {(s) => <div class="truncate opacity-60">{s()}</div>}
                                        </Show>
                                    </div>
                                </div>
                            );
                        }}
                    </For>
                </Show>
            </div>

            {/* 选中行详情：一行关键信息 + 输出尾部 */}
            <Show when={activeRow()}>
                {(row) => (
                    <div class="shrink-0 border-t px-3 py-2 text-body" data-job-detail>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span class="opacity-60">run</span>
                            <span class="font-mono text-xs">{row().runId}</span>
                            <span class="opacity-60">job</span>
                            <span class="font-mono text-xs">{row().jobId}</span>
                            <Show when={row().exitCode !== undefined}>
                                <span class="opacity-60">退出码 {row().exitCode}</span>
                            </Show>
                            <Show when={row().signal}>{(s) => <span class="opacity-60">信号 {s()}</span>}</Show>
                            <Show when={detail()?.droppedBytes}>
                                {(n) => (
                                    <span class="text-warning" data-tip="输出环只保留尾部，头部已被丢弃">
                                        已丢头 {fmtBytes(n())}
                                    </span>
                                )}
                            </Show>
                            <Show when={detailBusy()}>
                                <span class="opacity-50">读取输出…</span>
                            </Show>
                            <Show when={detailErr()}>{(m) => <span class="text-error">{m()}</span>}</Show>
                        </div>
                        <Show when={detail()?.tailLine}>
                            {(line) => (
                                <div class="mt-1 truncate opacity-80" data-job-tail-line data-tip="输出最后一行（进度探针看这里）">
                                    › {line()}
                                </div>
                            )}
                        </Show>
                        <Show when={detail()?.tail}>
                            {(tail) => (
                                <pre class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all bg-base-200/50 p-2 text-xs opacity-80">
                                    {tail()}
                                </pre>
                            )}
                        </Show>
                        <Show when={detail()?.logPath}>
                            {(p) => (
                                <div class="mt-1 truncate opacity-50" data-tip="settle 输出落盘路径（完整日志在这里）">
                                    {p()}
                                </div>
                            )}
                        </Show>
                    </div>
                )}
            </Show>
        </div>
    );
}
