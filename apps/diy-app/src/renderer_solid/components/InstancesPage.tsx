/**
 * InstancesPage — 导航「实例」页（##367）：本机现在有哪些 diy 实例在跑，一键切过去。
 *
 * 用户原话：
 *   > 是否能开发一个功能，可以列出所有当前的 diy 进程表格，类似 ps，显示谁开的/来源/任务名/id/app/
 *   > 当前会话信息 等信息，再加个「显示」按钮：全屏并获取焦点，可以快速切过去？
 *
 * 边界（父任务 ##366 交付后端，本页只做 UI）：
 *   · 数据只来自 `instances.list`（结构化行；**不解析** `instances ls` 的表格文本）；
 *   · 唤起只调 `instances.focus`，**失败必须看得见**（catch → 页面红条 + toast，绝不静默）；
 *   · **只读**：不提供任何「杀 / 停」入口 —— 生产实例（`~/.diy`）绝不可杀（guard）。
 *
 * 判据全在 `shared/instance-view.ts`（纯函数 + 单测，##329 R1）：能唤起吗 / 怎么排序 /
 * 这一刻该不该轮询 / 刷新后选中怎么留。本文件只做三件事：取数、排版、把动作接到既有出口。
 *
 * 为什么**不**用 ViewGrid（##351 的布局网格）：它是「谁在哪个 area、area 多大」的几何容器，
 * 不管数据行；本页要的是一张数据表。仓内没有可复用的数据表组件（会话总览页也是自己排的
 * `<table class="table table-sm">`），故与它同款，不新造抽象。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { findNode } from "../lib/task-lineage";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { ConfirmDialog } from "@diy-agent/ui-kit";
import type { InstanceRow } from "../../shared/instance-row";
import {
    INSTANCE_TONE_CLASS,
    DEFAULT_INSTANCE_SORT,
    INSTANCE_COLUMNS,
    INSTANCE_POLL_MS,
    INSTANCE_POLL_TICK_MS,
    decidePoll,
    focusReadiness,
    keepPid,
    nextSort,
    sortRowsForUi,
    statusView,
    summarizeRows,
    type InstanceSortKey,
    type InstanceViewCtx,
} from "../../shared/instance-view";

/** 错误对象 → 人话（RPC 抛的 Error 带的是服务端原文，直接透出） */
function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 窗口状态一行话（`window === null` = 该实例没有窗口，如 serve 模式） */
function windowText(row: InstanceRow): string {
    if (!row.window) return "无窗口（serve 模式 / 窗口已关 —— 没有窗口可唤起）";
    const parts = [row.window.visible ? "可见" : "隐藏"];
    if (row.window.minimized) parts.push("已最小化");
    if (row.window.fullScreen) parts.push("全屏");
    return parts.join(" · ");
}

export function InstancesPage() {
    const [rows, setRows] = createSignal<InstanceRow[]>([]);
    const [error, setError] = createSignal<string | null>(null);
    const [lastDoneAt, setLastDoneAt] = createSignal<number | null>(null);
    const [inFlight, setInFlight] = createSignal(false);
    /**
     * 已完成的刷新次数。**不只是给测试看的**：轮询坏掉时（页面不可见 / 判据写错）
     * 表面症状是"数据不新了"，而"不新"和"没变"长得一样 —— 墙上显示次数才分得清。
     */
    const [refreshCount, setRefreshCount] = createSignal(0);
    /** 页面是否可见（不可见 = 停轮询；见 shared/instance-view 的 decidePoll） */
    const [visible, setVisible] = createSignal(typeof document === "undefined" || document.visibilityState === "visible");
    /** 选中的行（pid，不是行对象也不是下标 —— 每轮刷新都会换一批新对象，见 keepPid） */
    const [selected, setSelected] = createSignal<number | null>(null);
    /** 展开明细的行（同为 pid） */
    const [expanded, setExpanded] = createSignal<number | null>(null);
    const [sort, setSort] = createSignal({ ...DEFAULT_INSTANCE_SORT });
    /** 待二次确认的唤起目标（null = 无弹窗） */
    const [confirmTarget, setConfirmTarget] = createSignal<InstanceRow | null>(null);
    /** 正在唤起的 pid（按钮转圈 + 防重入） */
    const [focusing, setFocusing] = createSignal<number | null>(null);

    /** 任务号/标题解析：查得到就用「#367 标题」，查不到（别的数据根上的任务）退回 uri 里的号 */
    const ctx: InstanceViewCtx = {
        taskOf: (uri) => {
            const n = findNode(taskStore.nodes, uri);
            return n ? { num: n.num ?? null, title: n.title ?? null } : null;
        },
    };

    const sorted = createMemo(() => sortRowsForUi(rows(), sort()));
    const summary = createMemo(() => summarizeRows(rows()));

    /**
     * 拉一次列表。**失败不静默**：错误进页面红条（`data-instance-error`），用户看得见，
     * 且 `lastDoneAt` 照常推进 —— 否则失败会退化成每 500ms 一次的紧重试。
     */
    const refresh = async () => {
        if (inFlight()) return;
        setInFlight(true);
        try {
            const r = await diyService.diy.instances.list({});
            setRows(r.rows);
            setError(null);
            // 刷新不得打断用户当前操作：选中 / 展开都按 pid 保留（实例退出才清空）
            setSelected((p) => keepPid(p, r.rows));
            setExpanded((p) => keepPid(p, r.rows));
        } catch (e) {
            setError(`拉取实例列表失败：${msgOf(e)}`);
        } finally {
            setInFlight(false);
            setLastDoneAt(Date.now());
            setRefreshCount((n) => n + 1); // 失败也算一次：计数说的是"轮询还在跑"，不是"每次都成功"
        }
    };

    /** 节拍器只负责"问"共享判据；真正发不发由 decidePoll 说了算（可单测） */
    const tick = () => {
        const d = decidePoll({
            visible: visible(),
            inFlight: inFlight(),
            now: Date.now(),
            lastDoneAt: lastDoneAt(),
            intervalMs: INSTANCE_POLL_MS,
        });
        if (d.action === "poll") void refresh();
    };

    onMount(() => {
        // 首屏无条件拉一次：标签页在后台开着时 visibilityState 就是 hidden，
        // 若也受"不可见不轮询"约束，页面会永远空着（见 decidePoll 的注）
        void refresh();
        const timer = setInterval(tick, INSTANCE_POLL_TICK_MS);
        const onVisibility = () => setVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", onVisibility);
        onCleanup(() => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        });
    });

    /**
     * 唤起：先应用内二次确认（`ConfirmDialog`，禁原生 `window.confirm` —— 它会卡住整个
     * 渲染进程且自动化点不到），确认后才发 RPC；失败把服务端原文亮出来。
     */
    const doFocus = async (row: InstanceRow) => {
        setConfirmTarget(null);
        setFocusing(row.pid);
        try {
            // pid 是权威定位（端口可能刚换）；port 一并带上只为满足契约形状（服务端优先用 pid）
            const r = await diyService.diy.instances.focus({ pid: row.pid, port: row.port ?? undefined });
            notificationStore.addToastLegacy("success", `已唤起 pid=${r.pid ?? row.pid}（${r.via}）：${r.reason}`);
            setError(null);
            void refresh(); // 全屏状态是目标实例自报的，紧接着取一次让它上屏
        } catch (e) {
            const m = msgOf(e);
            setError(`唤起 pid=${row.pid} 失败：${m}`);
            notificationStore.addToastLegacy("error", `唤起失败：${m}`);
        } finally {
            setFocusing(null);
        }
    };

    return (
        <div class="flex flex-col h-full min-h-0 p-4 gap-3" data-instances-page>
            <div class="shrink-0">
                <h2 class="text-display font-bold">实例</h2>
                <div class="text-body opacity-70 mt-1 flex items-center gap-3 flex-wrap">
                    <span data-instances-summary>
                        共 <b>{summary().total}</b> 个实例（<b>{summary().focusable}</b> 个可唤起）
                    </span>
                    <Show when={lastDoneAt() !== null}>
                        <span class="opacity-60" data-instances-refresh-count={refreshCount()}>
                            上次刷新：{new Date(lastDoneAt()!).toLocaleTimeString()}（第 {refreshCount()} 次）
                        </span>
                    </Show>
                    <Show when={inFlight()}>
                        <span class="badge badge-ghost badge-sm">刷新中…</span>
                    </Show>
                    {/* 「页面不可见时停」必须看得见：否则用户会以为刷新坏了 */}
                    <Show when={!visible()}>
                        <span class="badge badge-warning badge-sm" data-instances-paused>
                            页面不可见 · 已暂停自动刷新
                        </span>
                    </Show>
                    <span class="opacity-60">
                        只读：本页不提供杀 / 停实例的操作（生产实例绝不可杀 —— 见 guard）
                    </span>
                </div>
            </div>

            <div class="shrink-0 flex items-center gap-2 flex-wrap text-body">
                <button class="btn btn-xs" disabled={inFlight()} onClick={() => void refresh()} data-instances-refresh>
                    ⟳ 立即刷新
                </button>
                <span class="opacity-60">
                    每 {INSTANCE_POLL_MS / 1000}s 自动刷新一次（发现靠扫进程 + 跨实例自报；没有推送通道）
                </span>
            </div>

            {/* 失败必须看得见（禁静默）：拉取与唤起两条失败路径都落在这里 */}
            <Show when={error()}>
                <div class="alert alert-error shrink-0 py-2 text-body" role="alert" data-instance-error>
                    <span class="text-body">{error()}</span>
                </div>
            </Show>

            <div class="flex-1 min-h-0 overflow-auto">
                <Show
                    when={rows().length > 0}
                    fallback={
                        <div class="text-center opacity-60 py-10">
                            {lastDoneAt() === null ? "正在扫描本机实例…" : "本机没有扫到任何 diy 实例"}
                        </div>
                    }
                >
                    <table class="table table-sm w-full" data-instances-table>
                        <thead class="sticky top-0 bg-base-100 z-10">
                            <tr>
                                <th class="w-8" />
                                <For each={INSTANCE_COLUMNS}>
                                    {(col) => (
                                        <th class="whitespace-nowrap">
                                            <Show
                                                when={col.sortable}
                                                fallback={<span title={col.headTip}>{col.title}</span>}
                                            >
                                                <button
                                                    class="cursor-pointer hover:text-primary whitespace-nowrap"
                                                    title={`${col.headTip}（点击排序）`}
                                                    data-instance-sort={col.key}
                                                    onClick={() => setSort((s) => nextSort(s, col.key as InstanceSortKey))}
                                                >
                                                    {col.title}
                                                    <Show when={sort().key === col.key}>
                                                        <span class="ml-0.5">{sort().dir === "asc" ? "▲" : "▼"}</span>
                                                    </Show>
                                                </button>
                                            </Show>
                                        </th>
                                    )}
                                </For>
                                <th class="w-32">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={sorted()}>
                                {(row) => {
                                    const st = () => statusView(row.status);
                                    const ready = () => focusReadiness(row);
                                    const isSel = () => selected() === row.pid;
                                    const isOpen = () => expanded() === row.pid;
                                    return (
                                        <>
                                            <tr
                                                class={`border-b hover:bg-base-200 cursor-pointer ${isSel() ? "bg-primary/10" : ""}`}
                                                data-instance-pid={row.pid}
                                                aria-selected={isSel()}
                                                onClick={() => setSelected(row.pid)}
                                            >
                                                <td class="whitespace-nowrap">
                                                    <button
                                                        class="btn btn-ghost btn-xs"
                                                        title={isOpen() ? "收起明细" : "展开明细"}
                                                        aria-expanded={isOpen()}
                                                        data-instance-expand={row.pid}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setExpanded((p) => (p === row.pid ? null : row.pid));
                                                        }}
                                                    >
                                                        {isOpen() ? "▾" : "▸"}
                                                    </button>
                                                </td>
                                                <For each={INSTANCE_COLUMNS}>
                                                    {(col) => (
                                                        <td
                                                            class={`whitespace-nowrap align-top ${col.mono ? "font-mono" : ""} ${col.key === "status" ? INSTANCE_TONE_CLASS[st().tone] : ""} ${col.cellClass ?? ""}`}
                                                            title={col.tip(row, ctx)}
                                                        >
                                                            {col.text(row, ctx)}
                                                        </td>
                                                    )}
                                                </For>
                                                <td class="whitespace-nowrap">
                                                    <button
                                                        class="btn btn-xs btn-primary"
                                                        disabled={!ready().ok || focusing() === row.pid}
                                                        title={ready().reason}
                                                        data-instance-focus={row.pid}
                                                        onClick={() => setConfirmTarget(row)}
                                                    >
                                                        {focusing() === row.pid ? "唤起中…" : "显示"}
                                                    </button>
                                                </td>
                                            </tr>
                                            <Show when={isOpen()}>
                                                <tr class="bg-base-200/50" data-instance-detail={row.pid}>
                                                    <td />
                                                    <td colSpan={INSTANCE_COLUMNS.length + 1} class="text-body">
                                                        <div class="flex flex-col gap-1 py-1">
                                                            <div>
                                                                数据根：<span class="font-mono">{row.diyHome || "(未知)"}</span>（
                                                                {row.homeSource}）
                                                            </div>
                                                            <div>代码：<span class="font-mono">{row.repoDisplay || "(未知)"}</span></div>
                                                            <div>启动它的 cwd：<span class="font-mono">{row.cwd || "(未知)"}</span></div>
                                                            <div>窗口：{windowText(row)}</div>
                                                            <div>
                                                                在跑：{row.activeTurns.length === 0 ? "无" : row.activeTurns.map((t) => `${t.uri}（${t.steps} 步 · 起于 ${t.since}）`).join("；")}
                                                            </div>
                                                            <Show when={row.note}>
                                                                <div class="text-warning">⚠ {row.note}</div>
                                                            </Show>
                                                            <div class="opacity-70">命令：<span class="font-mono">{row.cmdline || "(未知)"}</span></div>
                                                            <div class="opacity-60">
                                                                唤起方式：{ready().reason}
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            </Show>
                                        </>
                                    );
                                }}
                            </For>
                        </tbody>
                    </table>
                    {/* 表格文本与页面的口径差异只有一处：表格末尾会附注 note，本页放进明细行 */}
                </Show>
            </div>

            <Show when={confirmTarget()}>
                {(row) => (
                    <ConfirmDialog
                        title={`唤起实例 pid=${row().pid}`}
                        message={`把 ${row().diyHomeDisplay || "(数据根未知)"} 的这个实例全屏并前置到最前（${focusReadiness(row()).reason}）`}
                        confirmLabel="全屏并前置"
                        onCancel={() => setConfirmTarget(null)}
                        onConfirm={() => void doFocus(row())}
                    />
                )}
            </Show>
        </div>
    );
}
