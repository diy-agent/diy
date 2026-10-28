// components/SessionOverviewPage.tsx — 全局会话可见性总览（##308 / ##358）。
//
// 用户原话要的是「**总的消费 view**」：不点进任何任务页，也能看到哪个会话在跑、token 在涨、
// 步数走到几；无人值守仍在烧的轮次必须在这里可见、可切进去看、可手动中断（##305 定案）。
//
// ##358 追加（用户 2026-10-17）：
//   · 行集**不只**注册表（进程性、重启即空）—— 还要包含**账本里有历史的会话**（跨启动），
//     否则一开 app 总览就是空表（"丢了所有进度"的现场）；
//   · 加**切片 / 过滤 / 排序**：范围（全部 vs 本次启动）· 状态切片 · 搜索 · 排序。
//
// 数据 = sessionStore（唯一注册表订阅）+ usageLedgerStore（账本，跨启动）+ taskStore（标题/项目）；
// 判据全在 shared/session-overview（行模型）与 shared/session-query（切片/过滤/排序）—— 本文件只做
// 三件事：排版、把动作接到既有出口（进会话 / cancel / setLimits）、把"为什么这么显示"写进 tooltip。
import { createMemo, createSignal, createEffect, For, Show } from "solid-js";
import { SessionGlyph, TONE_TEXT } from "./SessionGlyph";
import { ConfirmDialog } from "@diy/ui-kit";
import { sessionStore } from "../store/sessionStore";
import { taskStore } from "../store/taskStore";
import { usageLedgerStore } from "../store/usageLedgerStore";
import { notificationStore } from "../store/notificationStore";
import { getRendererActions } from "../lib/renderer-actions";
import { diyService } from "../lib/rpc";
import { allTaskUris, findNode } from "../lib/task-lineage";
import { Caches } from "../lib/ui-state";
import { endMarkOf } from "../../shared/turn-end";
import {
    fmtDuration,
    fmtStamp,
    fmtTokens,
    overviewRowOf,
    stepsProgressOf,
    type SessionOverviewRow,
    type SessionSlice,
} from "../../shared/session-overview";
import { idleMsOf, queueViewOf } from "../../shared/session-state";
import {
    SESSION_SLICES,
    SESSION_SORT_KEYS,
    applySessionQuery,
    formatSessionSort,
    formatSlices,
    parseScope,
    parseSessionSort,
    parseSlices,
    sessionCounts,
    toggleSessionSort,
    type SessionQuerySpec,
    type SessionScope,
    type SessionSortKey,
} from "../../shared/session-query";
import { fmtCost } from "../../shared/usage";
import type { SessionEntry } from "../../shared/registry-frame";

/** 条目的对外键（与 sessionStore 同口径：任务会话按 task uri 关联） */
function uriOf(e: SessionEntry): string {
    return e.refs.find((r) => r.kind === "task")?.uri ?? e.id;
}

/**
 * 单轮步数上限（**全局**：`maxSteps` 是运行限制，不是某个会话的属性）。
 *
 * 呈现照「任务属性」的标题编辑：**平时只显示值 + ✏️，点开才变输入框**
 * —— 原来"当前值 + 常驻输入框"说的是同一件事，用户 2026-10-17 指出这是重复。
 *
 * 语义照 RPC `agent.local.setLimits`：写 `$DIY_HOME/local/limits.json` + 即时失效缓存
 * ⇒ **下一轮生效**（在跑的轮次沿用起跑时的值，不中途换挡）。
 * ⚠️ 环境变量 `DIY_LOCAL_MAX_STEPS` 优先级更高：被钉死时写文件对它无效 —— 而返回值是
 * "合并后的生效值"，故回显以返回值（`sessionStore.maxSteps`）为准，不乐观写自己那个数。
 */
function MaxStepsEditor(props: { compact?: boolean }) {
    const [editing, setEditing] = createSignal(false);
    const [draft, setDraft] = createSignal<string>("");
    const [busy, setBusy] = createSignal(false);
    let inputRef: HTMLInputElement | undefined;

    const startEdit = () => {
        setDraft(String(sessionStore.maxSteps ?? ""));
        setEditing(true);
        // 就地编辑：一开就聚焦 + 全选（省一次点击，照任务属性标题编辑的手感）
        queueMicrotask(() => {
            inputRef?.focus();
            inputRef?.select();
        });
    };
    const cancel = () => {
        setEditing(false);
        setDraft("");
    };
    const apply = async () => {
        const n = Number(draft());
        if (!Number.isFinite(n) || n <= 0) {
            notificationStore.addToastLegacy("error", "步数上限必须是正数");
            return;
        }
        setBusy(true);
        try {
            await sessionStore.setMaxSteps(n);
            setEditing(false);
            setDraft("");
            notificationStore.addToastLegacy("success", `单轮步数上限已设为 ${n}（下一轮生效）`);
        } catch (e) {
            notificationStore.addToastLegacy("error", `写运行限制失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };
    return (
        <span
            class="inline-flex items-center gap-1"
            title="单轮最大模型步数（全局；下一轮生效。环境变量 DIY_LOCAL_MAX_STEPS 优先级更高，被钉死时写文件对它无效）"
        >
            <Show
                when={editing()}
                fallback={
                    <>
                        <Show when={!props.compact}>
                            <span class="opacity-70">单轮上限</span>
                        </Show>
                        <span class="font-mono">{sessionStore.maxSteps ?? "—"}</span>
                        <button
                            class="btn btn-ghost btn-xs opacity-60 hover:opacity-100"
                            title="编辑单轮步数上限"
                            onClick={startEdit}
                        >
                            ✏️
                        </button>
                    </>
                }
            >
                <input
                    ref={(el) => (inputRef = el)}
                    class="input input-bordered input-xs w-20 font-mono"
                    placeholder="200"
                    value={draft()}
                    onInput={(e) => setDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") void apply();
                        if (e.key === "Escape") cancel();
                    }}
                />
                <button class="btn btn-primary btn-xs" disabled={busy() || !draft()} onClick={() => void apply()}>
                    {busy() ? <span class="loading loading-spinner loading-xs" /> : "💾 保存"}
                </button>
                <button class="btn btn-ghost btn-xs" disabled={busy()} onClick={cancel}>
                    取消
                </button>
            </Show>
        </span>
    );
}

/** 可排序表头（照 TaskTree 的 SortableTh 手感：当前列带箭头，其余 hover 才提示可点） */
function SortTh(props: {
    k: SessionSortKey;
    sort: SessionQuerySpec["sort"];
    onSort: (k: SessionSortKey) => void;
    class?: string;
}) {
    const meta = SESSION_SORT_KEYS.find((s) => s.key === props.k)!;
    const active = () => props.sort.key === props.k;
    return (
        <th class={`py-1 ${props.class ?? ""}`}>
            <button
                class={`btn btn-ghost btn-xs px-1 min-h-0 h-5 font-semibold normal-case gap-0.5 ${
                    active() ? "text-primary" : "opacity-70 hover:opacity-100"
                }`}
                title={`${meta.title}（点击排序）`}
                onClick={() => props.onSort(props.k)}
            >
                <span>{meta.label}</span>
                <span class="text-caption">{active() ? (props.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
            </button>
        </th>
    );
}

/** 状态切片 → 短文案（表里"现在怎么了"那一列；未读条数在**单独一列**，不在这里重复） */
function sliceText(r: SessionOverviewRow, now: number): string {
    switch (r.slice) {
        case "working":
            return "运行中";
        case "stalled":
            return `停滞 ${fmtDuration(r.entry ? (idleMsOf(r.entry, now) ?? 0) : 0)}`;
        case "error":
            return r.entry ? endMarkOf(r.entry.lastEndReason, false).tip : "异常终止";
        case "unread":
            return "未读";
        case "queued":
            return r.entry ? queueViewOf(r.entry).label : "待投递";
        default:
            return "已对话";
    }
}

export function SessionOverviewPage() {
    /** 行内「阈值」展开的那一行（全局值，展开只是省一次滚动） */
    const [limitFor, setLimitFor] = createSignal<string | null>(null);
    /** 待确认的强制中断目标 */
    const [confirmFor, setConfirmFor] = createSignal<SessionOverviewRow | null>(null);

    // ── 切片 / 过滤 / 排序（视图 cache：丢了只是清掉过滤，无数据损失） ──
    const [scope, setScope] = createSignal<SessionScope>(parseScope(Caches.diy_session_overview_scope.get()));
    const [slices, setSlices] = createSignal<SessionSlice[]>(parseSlices(Caches.diy_session_overview_slices.get()));
    const [query, setQuery] = createSignal<string>(Caches.diy_session_overview_query.get());
    const [sort, setSort] = createSignal<SessionQuerySpec["sort"]>(parseSessionSort(Caches.diy_session_overview_sort.get()));

    const spec = createMemo<SessionQuerySpec>(() => ({
        scope: scope(),
        slices: slices(),
        query: query(),
        sort: sort(),
    }));

    const applyScope = (v: SessionScope) => {
        setScope(v);
        Caches.diy_session_overview_scope.set(v);
    };
    const toggleSlice = (k: SessionSlice) => {
        const next = slices().includes(k) ? slices().filter((s) => s !== k) : [...slices(), k];
        setSlices(next);
        Caches.diy_session_overview_slices.set(formatSlices(next));
    };
    const applyQuery = (v: string) => {
        setQuery(v);
        Caches.diy_session_overview_query.set(v);
    };
    const applySort = (k: SessionSortKey) => {
        const next = toggleSessionSort(sort(), k);
        setSort(next);
        Caches.diy_session_overview_sort.set(formatSessionSort(next));
    };
    /** 清空全部过滤条件。排序**钉回默认**（不走 `applySort` —— 那是"切换"，点两下会翻回去） */
    const resetFilters = () => {
        applyScope("all");
        setSlices([]);
        Caches.diy_session_overview_slices.set("");
        applyQuery("");
        const def: SessionQuerySpec["sort"] = { key: "attention", dir: "asc" };
        setSort(def);
        Caches.diy_session_overview_sort.set(formatSessionSort(def));
    };

    /**
     * 账本扫描：任务树里**全部任务**的账本各要一次。
     *
     * 为什么扫全量（用户 2026-10-17 拍板「要」）：总览要能列"账本里有历史的会话"，
     * 而"哪些任务聊过"只有账本知道 —— 不扫就只能等用户一个个点进去。
     * 代价由 usageLedgerStore 兜着：**永久缓存 + 并发上限 4 + 失败不落假值**；
     * 且只在本页挂载时发起（不在 app 启动时全局扫）。
     */
    const taskUris = createMemo(() => allTaskUris(taskStore.nodes));
    createEffect(() => {
        const us = taskUris();
        if (us.length > 0) usageLedgerStore.ensure(...us);
    });

    /** 全集行（注册表 ∪ 账本历史 ∪ 任务树）—— 未过滤，"计数"与"显示"都从它派生 */
    const allRows = createMemo<SessionOverviewRow[]>(() => {
        const uris = new Set<string>(taskUris());
        for (const e of sessionStore.entries) uris.add(uriOf(e));
        const out: SessionOverviewRow[] = [];
        for (const uri of uris) {
            const node = findNode(taskStore.nodes, uri);
            const row = overviewRowOf({
                uri,
                entry: sessionStore.byUri(uri),
                // 账本事实（跨启动）：TaskLedgerFacts 与 LedgerView 同形，直接传
                ledger: usageLedgerStore.factsOf(uri),
                seenTurns: sessionStore.seenTurnsOf(uri),
                maxSteps: sessionStore.maxSteps,
                now: sessionStore.nowMs,
                num: node?.num,
                title: node?.title,
                project: node?.project_label ?? node?.project,
            });
            if (row) out.push(row);
        }
        return out;
    });

    /** 范围口径下的全集：切片计数按它算（chips 上"有几个"不该受**已选切片**影响） */
    const scopedRows = createMemo(() => allRows().filter((r) => scope() === "all" || !!r.entry));
    const counts = createMemo(() => sessionCounts(scopedRows()));
    /** 真正显示的行 = 过滤 + 排序 */
    const rows = createMemo(() => applySessionQuery(allRows(), spec()));
    const working = createMemo(() => allRows().filter((r) => r.running));
    const sessionActive = createMemo(() => allRows().filter((r) => !!r.entry).length);

    const enter = (uri: string) => getRendererActions().openTaskRun?.(uri);

    /**
     * 强制中断（承 ##305 的"人在全局视图上手动停"出口）。
     *
     * 直接走 `cancel` RPC —— 它与会话页停止按钮**同一个入口**（main 侧幂等，无在途返 false 不抛错）。
     * 若本窗口正开着该会话，它的页面会在 main 收尾的 op/真值刷新里自己归位（不必本页代管状态）。
     */
    const forceCancel = async (r: SessionOverviewRow) => {
        setConfirmFor(null);
        try {
            const res = await diyService.diy.agent.local.cancel({ taskUri: r.uri });
            notificationStore.addToastLegacy(
                res.cancelled ? "success" : "info",
                res.cancelled ? `已中断 ${r.uri} 的轮次` : "该会话此刻没有在跑的轮次（可能刚好收尾了）",
            );
        } catch (err) {
            notificationStore.addToastLegacy("error", `中断失败：${err instanceof Error ? err.message : String(err)}`);
        }
    };

    return (
        <div class="flex flex-col p-4 h-full min-h-0 gap-3">
            <div class="shrink-0">
                <h2 class="text-display font-bold">会话总览</h2>
                <div class="text-body opacity-70 mt-1 flex items-center gap-3 flex-wrap">
                    <span>
                        聊过 <b>{allRows().length}</b> 个会话（本次启动活跃 <b>{sessionActive()}</b> 个）· 在跑{" "}
                        <b>{working().length}</b> 个
                    </span>
                    <Show when={rows().length !== allRows().length}>
                        <span class="badge badge-ghost badge-sm">
                            过滤后显示 {rows().length} / {allRows().length}
                        </span>
                    </Show>
                    <Show when={sessionStore.connection !== "live"}>
                        <span class="badge badge-warning badge-sm">
                            {sessionStore.connection === "down" ? "注册表订阅已断，重连中…" : "连接注册表…"}
                        </span>
                    </Show>
                    <span class="text-body opacity-60">
                        窗口最小化 ≠ 停止：轮次归 main 驱动，仅由单轮步数上限收口（##305）
                    </span>
                </div>
            </div>

            {/* ── 切片 / 过滤条 ─────────────────────────────────────────── */}
            <div class="shrink-0 flex items-center gap-x-3 gap-y-2 flex-wrap text-body border border-base-300 rounded-lg px-2 py-1.5">
                {/* 范围：账本历史要不要一起列 */}
                <div class="join" title="范围：全部 = 含账本落盘的历史会话（跨启动）· 本次启动 = 只看注册表里本进程活跃过的">
                    <button
                        class={`btn btn-xs join-item ${scope() === "all" ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => applyScope("all")}
                    >
                        全部
                    </button>
                    <button
                        class={`btn btn-xs join-item ${scope() === "session" ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => applyScope("session")}
                    >
                        本次启动
                    </button>
                </div>

                {/* 状态切片（多选；空 = 全部）。计数按**范围口径**算，不受已选切片影响 */}
                <div class="flex items-center gap-1 flex-wrap">
                    <For each={SESSION_SLICES}>
                        {(s) => (
                            <button
                                class={`btn btn-xs gap-1 ${
                                    slices().includes(s.key) ? "btn-primary" : counts()[s.key] > 0 ? "" : "btn-ghost opacity-50"
                                }`}
                                title={`${s.title}（点一下按它过滤，可多选；再点取消）`}
                                disabled={counts()[s.key] === 0 && !slices().includes(s.key)}
                                onClick={() => toggleSlice(s.key)}
                                data-slice={s.key}
                            >
                                {s.label}
                                <span class="badge badge-xs">{counts()[s.key]}</span>
                            </button>
                        )}
                    </For>
                </div>

                {/* 搜索：uri / 任务号 / 标题 / 项目 */}
                <input
                    class="input input-bordered input-xs w-52"
                    placeholder="搜索 uri / 编号 / 标题 / 项目"
                    value={query()}
                    onInput={(e) => applyQuery(e.currentTarget.value)}
                />

                <button class="btn btn-ghost btn-xs" title="清空所有过滤条件（范围 / 切片 / 搜索 / 排序）" onClick={resetFilters}>
                    清空过滤
                </button>
            </div>

            <div class="shrink-0 flex items-center gap-2 flex-wrap text-body">
                <MaxStepsEditor />
                <span class="opacity-60">在跑的轮次不换挡；改完从下一轮起生效</span>
            </div>

            <div class="flex-1 min-h-0 overflow-auto">
                <Show
                    when={allRows().length > 0}
                    fallback={
                        <div class="text-center opacity-60 py-10">
                            还没有聊过的会话
                            <div class="text-body opacity-70 mt-1">
                                （总览只列**聊过**的会话：注册表本进程事实 ∪ 账本落盘历史。
                                没有任何账本记录的任务不在这里 —— 它们还没开始对话）
                            </div>
                        </div>
                    }
                >
                    <Show
                        when={rows().length > 0}
                        fallback={
                            <div class="text-center opacity-60 py-10">
                                没有符合当前过滤条件的会话
                                <div class="mt-2">
                                    <button class="btn btn-xs" onClick={resetFilters}>
                                        清空过滤
                                    </button>
                                </div>
                            </div>
                        }
                    >
                        <table class="table table-sm w-full">
                            <thead class="sticky top-0 bg-base-100 z-10">
                                <tr>
                                    <SortTh k="attention" sort={sort()} onSort={applySort} class="w-40" />
                                    <th>任务</th>
                                    <th class="w-28">模型</th>
                                    <SortTh k="unread" sort={sort()} onSort={applySort} class="w-16" />
                                    <SortTh k="steps" sort={sort()} onSort={applySort} class="w-36" />
                                    <SortTh k="tokens" sort={sort()} onSort={applySort} class="w-20" />
                                    <SortTh k="cost" sort={sort()} onSort={applySort} class="w-24" />
                                    <th class="w-36">待投递留言</th>
                                    <th class="w-14">看客</th>
                                    <th class="w-20">已跑</th>
                                    <SortTh k="lastActivity" sort={sort()} onSort={applySort} class="w-28" />
                                    <th class="w-44">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={rows()}>
                                    {(r) => {
                                        const entry = () => r.entry;
                                        // 进度格式（`k/max`）**只在有在跑轮次时**才有意义：
                                        // 空转的会话该显示"累计 N 步"（不带上限），否则会读成"跑到第 k 步了"
                                        const prog = () =>
                                            entry()?.turn ? stepsProgressOf(entry()!, sessionStore.maxSteps) : null;
                                        const q = () => (entry() ? queueViewOf(entry()!) : null);
                                        const mark = () =>
                                            entry() ? endMarkOf(entry()!.lastEndReason, entry()!.turn !== null) : null;
                                        const runMs = () => {
                                            const e = entry();
                                            if (!e?.turn) return null;
                                            const t = Date.parse(e.turn.startedAt);
                                            return Number.isFinite(t) ? sessionStore.nowMs - t : null;
                                        };
                                        return (
                                            <tr class="border-b hover:bg-base-200" title={r.tip}>
                                                {/* 活动：**图标 + 状态词**（##393 四处同一个组件 / 同一个判据）。
                                                    表格空间大 ⇒ 「可展示地方大了，可以分列」：图标与文字一列、
                                                    未读条数**单独一列**（值同出自 `overviewRowOf`，不是另一份判据）。 */}
                                                <td class="whitespace-nowrap">
                                                    <span class="inline-flex items-center gap-1" title={r.tip}>
                                                        <SessionGlyph uri={r.uri} size="xs" withMarks={false} />
                                                        <span class={TONE_TEXT[r.glyph.tone]}>
                                                            {sliceText(r, sessionStore.nowMs)}
                                                        </span>
                                                    </span>
                                                </td>
                                                {/* 任务：编号 + 标题（会话状态已在活动列，不再挂第二个 chip —— 用户 3.1 反对重复） */}
                                                <td class="text-body">
                                                    <span class="inline-flex items-center gap-1 flex-wrap">
                                                        <button
                                                            class="diy-link underline-offset-2 hover:underline cursor-pointer text-left"
                                                            onClick={() => enter(r.uri)}
                                                        >
                                                            {r.num ? `#${r.num} ` : ""}
                                                            {r.title ?? r.uri}
                                                        </button>
                                                    </span>
                                                    <div class="text-body opacity-50 font-mono truncate">
                                                        {r.project ? `${r.project} · ` : ""}
                                                        {r.uri}
                                                    </div>
                                                </td>
                                                <td class="text-body font-mono opacity-80">
                                                    {entry()?.turn?.model ?? "—"}
                                                </td>
                                                {/* 未读（1 轮 = 1 条；跨启动）—— 单独一列，可排序 */}
                                                <td class="text-body">
                                                    <Show when={r.unread > 0} fallback={<span class="opacity-40">—</span>}>
                                                        <span
                                                            class="badge badge-primary badge-xs"
                                                            title="距你上次看这个会话，它又跑完了这么多轮（1 轮 = 1 条未读消息；跨启动）"
                                                        >
                                                            +{r.unread}
                                                        </span>
                                                    </Show>
                                                </td>
                                                {/* 步数：在跑 → 进度条；否则累计（跨启动） */}
                                                <td class="text-body">
                                                    <Show when={prog()} fallback={
                                                        <Show
                                                            when={r.steps !== undefined}
                                                            fallback={<span class="opacity-40">—</span>}
                                                        >
                                                            <span class="font-mono" title="会话累计步数（注册表本进程 ∪ 账本落盘，跨启动）">
                                                                {r.steps} 步
                                                            </span>
                                                        </Show>
                                                    }>
                                                        {(p) => (
                                                            <>
                                                                <span class="font-mono">{p().text}</span>
                                                                <Show when={p().pct !== null}>
                                                                    <progress
                                                                        class={`progress w-20 align-middle ml-2 ${p().pct! >= 0.9 ? "progress-error" : "progress-primary"}`}
                                                                        value={p().done}
                                                                        max={p().limit!}
                                                                    />
                                                                </Show>
                                                            </>
                                                        )}
                                                    </Show>
                                                </td>
                                                <td class="text-body font-mono opacity-80 whitespace-nowrap">
                                                    <Show
                                                        when={r.tokens !== undefined}
                                                        fallback={<span class="opacity-40">—</span>}
                                                    >
                                                        <span title="会话累计 token（注册表本进程 ∪ 账本落盘，跨启动）">
                                                            {fmtTokens(r.tokens!)}
                                                        </span>
                                                    </Show>
                                                </td>
                                                <td class="text-body font-mono opacity-80 whitespace-nowrap">
                                                    <Show
                                                        when={r.cost !== undefined && r.cost !== null}
                                                        fallback={<span class="opacity-40">—</span>}
                                                    >
                                                        <span title="任务会话累计消费（$；账本 usage.jsonl，跨启动）">
                                                            ${fmtCost(r.cost!)}
                                                        </span>
                                                    </Show>
                                                </td>
                                                <td class="text-body">
                                                    <Show
                                                        when={q() && q()!.kind !== "none"}
                                                        fallback={<span class="opacity-40">—</span>}
                                                    >
                                                        <span class="badge badge-warning badge-sm" title={q()!.tip}>
                                                            {q()!.label}
                                                        </span>
                                                    </Show>
                                                </td>
                                                <td class="text-body font-mono opacity-80">{entry()?.viewers ?? "—"}</td>
                                                <td
                                                    class="text-body font-mono opacity-80 whitespace-nowrap"
                                                    title={`轮次起始 ${entry()?.turn?.startedAt ?? "—"}`}
                                                >
                                                    {runMs() === null ? "—" : fmtDuration(runMs()!)}
                                                </td>
                                                {/* 最后活动 = 时间（跨启动）+ 上一轮结束标记（有才显示） */}
                                                <td class="text-body whitespace-nowrap" title={r.lastActivity ?? ""}>
                                                    <Show when={mark()?.icon}>
                                                        <span
                                                            class={`mr-1 ${
                                                                mark()!.tone === "err"
                                                                    ? "text-error"
                                                                    : mark()!.tone === "ok"
                                                                      ? "text-success"
                                                                      : "text-warning"
                                                            }`}
                                                            title={`上一轮：${mark()!.tip}`}
                                                        >
                                                            {mark()!.icon}
                                                        </span>
                                                    </Show>
                                                    <Show
                                                        when={r.lastActivity}
                                                        fallback={<span class="opacity-40">—</span>}
                                                    >
                                                        <span class="opacity-70">{fmtStamp(r.lastActivity)}</span>
                                                    </Show>
                                                </td>
                                                <td class="whitespace-nowrap">
                                                    <div class="flex items-center gap-1">
                                                        <button class="btn btn-xs" onClick={() => enter(r.uri)}>
                                                            进入会话
                                                        </button>
                                                        <button
                                                            class="btn btn-xs btn-error"
                                                            disabled={!r.running}
                                                            title="中断在跑的轮次（main 侧幂等；无人值守也可停）"
                                                            onClick={() => setConfirmFor(r)}
                                                        >
                                                            强制中断
                                                        </button>
                                                        <button
                                                            class="btn btn-xs btn-ghost"
                                                            title="调整单轮步数上限（全局）"
                                                            onClick={() =>
                                                                setLimitFor(limitFor() === r.uri ? null : r.uri)
                                                            }
                                                        >
                                                            阈值
                                                        </button>
                                                    </div>
                                                    <Show when={limitFor() === r.uri}>
                                                        <div class="mt-1">
                                                            <MaxStepsEditor compact />
                                                        </div>
                                                    </Show>
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </Show>
            </div>

            <Show when={confirmFor()}>
                {(r) => (
                    <ConfirmDialog
                        title="强制中断这一轮？"
                        message={`将中断 ${r().uri} 正在跑的轮次（模型会停手，本轮按"被中断"收尾）。无人值守的轮次也照样能停。`}
                        confirmLabel="中断"
                        onCancel={() => setConfirmFor(null)}
                        onConfirm={() => void forceCancel(r())}
                    />
                )}
            </Show>
        </div>
    );
}
