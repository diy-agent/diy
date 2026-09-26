import { createSignal, createMemo, For, Show, onCleanup, onMount } from "solid-js";
import { createMutable } from "solid-js/store";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable, PointerSensor } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { taskStore, type TreeNode } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { diyService } from "../lib/rpc";
import { Caches } from "../lib/ui-state";
import { CreateProjectSheet } from "./CreateProjectSheet";
import { TASK_STATES, taskStateColor } from "../../main/core/task-state";
import { CreateTaskSheet } from "./CreateTaskSheet";
import { DynamicBar } from "./DynamicBar";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import {
    SORT_KEYS,
    buildTaskRows,
    formatSort,
    parseSort,
    taskRowKey,
    toggleSort,
    type SortKey,
    type SortSpec,
    type SearchSnippet,
} from "../../shared/task-list";

// dnd-kit/solid 未直接导出 DragEndEvent，从 onDragEnd 回调参数提取
type DragEndEvent = Parameters<NonNullable<DragDropProviderProps["onDragEnd"]>>[0];


interface FlatRow {
    key: string;
    kind: "project" | "task";
    node: TreeNode;
    depth: number;
    projectId: string;
    /** 命中的正文片段（搜索态才有；标题命中时为 null）。就地赋值，行对象引用终身不变 */
    snippet: SearchSnippet | null;
}

/**
 * 行对象缓存：key → 稳定的可变行（createMutable 代理，引用终身不变）。
 *
 * 为什么必须稳定：`<For>` 按「引用相等」复用 DOM（见 solid-js mapArray）。
 * 若每次展开都新建行对象，全部行引用都变 → 整个 tbody 被销毁重建：
 *   1. 滚动容器内容瞬间清空，scrollTop 被钳回 0（表现为「页面跳到最上面」）
 *   2. 被点击的展开按钮随之销毁，焦点掉回 body（方向键导航失效）
 * 缓存后展开/折叠只增删受影响的行，其余行 DOM 原样保留。
 * node/depth/projectId 用赋值就地更新（Solid store 对相等赋值不触发通知），
 * 所以 loadTree 刷新任务树时内容照常响应式更新，DOM 不重建。
 *
 * 排序同理：**排序只改行的顺序，不改行的身份** → `<For>` 移动 DOM 而不是重建，
 * 展开状态/焦点/滚动位置都不会因点表头排序而丢失。
 */
const rowCache = new Map<string, FlatRow>();

function cachedRow(
    key: string,
    kind: "project" | "task",
    node: TreeNode,
    depth: number,
    projectId: string,
    snippet: SearchSnippet | null,
    seen: Set<string>,
): FlatRow {
    seen.add(key);
    let row = rowCache.get(key);
    if (!row) {
        row = createMutable<FlatRow>({ key, kind, node, depth, projectId, snippet });
        rowCache.set(key, row);
    } else {
        row.node = node;
        row.depth = depth;
        row.projectId = projectId;
        row.snippet = snippet;
    }
    return row;
}

interface TaskProjectInfo {
    project: string;
    parent: string | undefined;
}

function findTaskProject(nodes: TreeNode[], uri: string): TaskProjectInfo | null {
    for (const p of nodes) {
        if (p.kind !== "project") continue;
        const f = findInTree(p.children, uri);
        if (f) return { project: p.project ?? "", parent: f.parentUri };
    }
    return null;
}

function findInTree(children: TreeNode[], uri: string): TreeNode | null {
    for (const c of children) {
        if (c.uri === uri) return c;
        const f = findInTree(c.children, uri);
        if (f) return f;
    }
    return null;
}

// 状态全集来自单一真相源 task-state.ts（main 与 renderer 共用）
const allStates: readonly string[] = TASK_STATES;
const stateLabel: Record<string, string> = {
    pending: "待处理",
    active: "进行中",
    done: "已完成",
    cancelled: "已取消",
    blocked: "已阻塞",
    shelved: "已搁置",
    new: "新建",
    open: "已打开",
    closed: "已关闭",
};

function StateSelector(props: { uri: string; state: string }) {
    const [open, setOpen] = createSignal(false);

    const changeState = async (s: string, e: MouseEvent) => {
        e.stopPropagation();
        setOpen(false);
        await taskStore.setState(props.uri, s);
    };

    return (
        <span class="relative inline-block" onClick={(e) => e.stopPropagation()}>
            <button
                class={"btn btn-xs btn-ghost gap-1 normal-case font-normal"}
                onClick={() => setOpen((p) => !p)}
            >
                <span class={`w-2 h-2 rounded-full inline-block ${taskStateColor(props.state)}`} />
                {stateLabel[props.state] ?? props.state}
            </button>
            <Show when={open()}>
                <ul
                    class="menu bg-base-100 border border-base-300 rounded-box shadow-lg absolute left-0 top-full z-50 mt-1 w-32 p-1"
                    onClick={() => setOpen(false)}
                >
                    <For each={allStates}>
                        {(s) => (
                            <li>
                                <button
                                    class={`text-xs gap-2 ${s === props.state ? "active font-bold" : ""}`}
                                    onClick={(e) => changeState(s, e)}
                                >
                                    <span class={`w-2 h-2 rounded-full inline-block ${taskStateColor(s)}`} />
                                    {stateLabel[s]}
                                </button>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </span>
    );
}

// ═══════════════════════════════════════
// 单元格渲染小工具
// ═══════════════════════════════════════

/** `2026-09-25T14:23:19.005Z` → `09-25 14:23`（本地时间）。
 *  列宽有限，完整时刻放 title（hover 可见），也放详情面板。 */
function fmtTime(iso: string | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 可空字段的占位符：空值统一显示 "—"，让"没填"和"填了空"在视觉上一致地可辨 */
function Dash() {
    return <span class="opacity-30">—</span>;
}

/** 优先级色：P0 最紧急 → error；P1 warning；P2/P3 中性 */
function priorityClass(p: string): string {
    if (p === "P0") return "badge-error";
    if (p === "P1") return "badge-warning";
    return "badge-ghost";
}

/** 排序表头：点击切换。当前排序列带箭头（↑/↓），其余列 hover 才提示可点 */
function SortableTh(props: {
    sortKey: SortKey;
    sort: SortSpec;
    onSort: (k: SortKey) => void;
    /** 额外的 th class（标题列要保底宽度，不然被长标题挤没） */
    class?: string;
}) {
    const meta = SORT_KEYS.find((s) => s.key === props.sortKey)!;
    const active = () => props.sort.key === props.sortKey;
    return (
        <th class={`py-1 ${props.class ?? ""}`}>
            <button
                class={`btn btn-ghost btn-xs px-1 min-h-0 h-5 font-semibold normal-case gap-0.5 ${
                    active() ? "text-primary" : "opacity-70 hover:opacity-100"
                }`}
                title={`${meta.title}（点击排序）`}
                onClick={() => props.onSort(props.sortKey)}
            >
                <span>{meta.label}</span>
                <span class="text-[9px]">{active() ? (props.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
            </button>
        </th>
    );
}

export function TaskTree() {
    // 展开/滚动/排序/搜索：视图 cache（lib/ui-state，localStorage 归一定位），可被清理入口清空
    const loadExpanded = (): Set<string> => {
        try {
            return new Set(Caches.diy_task_tree_expanded.get());
        } catch {
            return new Set();
        }
    };
    const saveExpanded = (s: Set<string>) => {
        try {
            Caches.diy_task_tree_expanded.set([...s]);
        } catch { /* 存储不可用忽略 */ }
    };
    const [expanded, setExpanded] = createSignal<Set<string>>(loadExpanded());
    const [sort, setSort] = createSignal<SortSpec>(parseSort(Caches.diy_task_tree_sort.get()));
    const [query, setQuery] = createSignal<string>(Caches.diy_task_tree_query.get());
    /** 搜索焦点：第几个命中（0 基）。换搜索词 → 归零 */
    const [focusIdx, setFocusIdx] = createSignal(0);
    let searchRef: HTMLInputElement | undefined;
    const bindSearch = (el: HTMLInputElement) => { searchRef = el; };

    const applySort = (key: SortKey) => {
        const next = toggleSort(sort(), key);
        setSort(next);
        try {
            Caches.diy_task_tree_sort.set(formatSort(next));
        } catch { /* 存储不可用忽略 */ }
    };
    const applyQuery = (v: string) => {
        setQuery(v);
        setFocusIdx(0);
        try {
            Caches.diy_task_tree_query.set(v);
        } catch { /* 存储不可用忽略 */ }
    };

    // 展开判定：**项目默认展开、任务默认折叠**（两种节点语义相反，故 key 的成员含义相反）
    const isExpanded = (n: TreeNode): boolean =>
        n.kind === "project" ? !expanded().has(taskRowKey(n)) : expanded().has(taskRowKey(n));

    /** 搜索态：有查询词即为真（表格剪枝、动态条显示、命中高亮都由它决定） */
    const searching = () => query().trim().length > 0;

    /** 构建结果（含命中信息）。rows 与 hits 都从这里派生 —— 不让 hits 再匹配一遍：
     *  匹配是 O(节点数 × 正文字符数) 的活，同一次渲染里做两遍纯属浪费。 */
    const list = createMemo(() => buildTaskRows(taskStore.nodes, { sort: sort(), query: query(), isExpanded }));

    const rows = createMemo(() => {
        const seen = new Set<string>();
        const out = list().map((r) =>
            cachedRow(
                taskRowKey(r.node),
                r.node.kind,
                r.node,
                r.depth,
                r.node.project ?? "",
                r.match?.snippet ?? null,
                seen,
            ),
        );
        // 回收本次不可见的行缓存（任务被删除/折叠），避免缓存无限增长。
        //
        // **搜索态跳过回收**（否则每次敲字都把未命中行的身份丢掉）：搜索是剪枝，
        // 未命中行只是"暂时不渲染"，不是消失；若顺手回收，清空搜索时那些行会被当作
        // 新行重建 → `<For>` 销毁重建整块 tbody → 滚动位置被钳回 0、焦点掉回 body。
        // 搜索期间不回收的代价可忽略：缓存以任务总数为上限（本项目百来条），
        // 且清空搜索后这一行会立刻把不再存在的键收干净。
        if (!searching()) {
            for (const k of rowCache.keys()) if (!seen.has(k)) rowCache.delete(k);
        }
        return out;
    });

    /** 搜索结果集（按树序的任务命中行）：动态条的 ↑/↓ 与 N/M 计数都基于它。
     *  `match !== null` 即命中（正文命中时 match 带片段，标题等字段命中时片段为 null）——
     *  祖先行是被"保链"保下来的，match 恒为 null，不会混进命中集。 */
    const hits = createMemo(() =>
        searching()
            ? list()
                  .filter((r) => r.node.kind === "task" && r.match !== null)
                  .map((r) => taskRowKey(r.node))
            : [],
    );
    const focusUri = createMemo(() => hits()[Math.min(focusIdx(), Math.max(0, hits().length - 1))]);

    /** 跳到第 i 个命中：选中它并滚动到可视区（行 DOM 用 data-uri 定位） */
    const gotoHit = (i: number) => {
        const list = hits();
        if (list.length === 0) return;
        const idx = ((i % list.length) + list.length) % list.length;
        setFocusIdx(idx);
        const uri = list[idx]!;
        void taskStore.selectTask(uri);
        requestAnimationFrame(() => {
            document.querySelector(`[data-uri="${CSS.escape(uri)}"]`)?.scrollIntoView({ block: "nearest" });
        });
    };

    const selectable = createMemo(() =>
        rows()
            .filter((r) => r.kind === "task")
            .map((r) => r.key),
    );
    const toggle = (k: string) =>
        setExpanded((p) => {
            const n = new Set(p);
            if (n.has(k)) n.delete(k);
            else n.add(k);
            saveExpanded(n);
            return n;
        });
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const cur = selectable().indexOf(taskStore.selectedUri as string);
        const next = e.key === "ArrowDown" ? (cur < selectable().length - 1 ? cur + 1 : 0) : cur > 0 ? cur - 1 : selectable().length - 1;
        if (selectable()[next]) taskStore.selectTask(selectable()[next]);
    };

    // ⌘/Ctrl+F 聚焦搜索框：与浏览器/编辑器一致的心智模型（Esc 清空）
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
                e.preventDefault();
                searchRef?.focus();
                searchRef?.select();
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    const scrollRef = (el: HTMLDivElement | undefined) => {
        if (!el || el.dataset.scrollRestored === "1") return;
        el.dataset.scrollRestored = "1";
        // 等首次 loadTree 渲染完成再恢复滚动位置
        void taskStore.loadTree().then(() => {
            const v = Caches.diy_task_tree_scroll.get();
            if (v > 0) el.scrollTop = v;
        });
    };
    const onScroll = (e: Event) => {
        try {
            Caches.diy_task_tree_scroll.set((e.currentTarget as HTMLDivElement).scrollTop);
        } catch { /* 存储不可用忽略 */ }
    };

    // ── dnd-kit/solid 拖拽改父级 / 提升层级 ──
    const handleDragEnd = async (event: DragEndEvent) => {
        if (event.operation?.canceled) return;
        const dragUri = String(event.operation?.source?.id ?? "");
        const dropUri = String(event.operation?.target?.id ?? "");
        if (!dragUri || !dropUri || dragUri === dropUri) return;
        const dragInfo = findTaskProject(taskStore.nodes, dragUri);
        if (!dragInfo) return;

        // 拖到项目节点(proj:<pid>) → 取消父子层级，提升为该项目的一级任务
        if (dropUri.startsWith("proj:")) {
            const projId = dropUri.slice(5);
            if (dragInfo.project !== projId) {
                notificationStore.addToast("error", "只能移动到同一项目内");
                return;
            }
            if (!dragInfo.parent) return; // 已是一级任务，无需操作
            try {
                await diyService.diy.task.move({ uri: dragUri, parent: "" });
                await taskStore.loadTree();
                // 项目默认展开(expanded 含 key=折叠)，delete 确保提升后保持展开、1级任务可见
                setExpanded((prev) => {
                    const n = new Set(prev);
                    n.delete(dropUri);
                    return n;
                });
                notificationStore.addToast("success", "已提升为一级任务");
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                notificationStore.addToast("error", `提升失败: ${msg}`);
            }
            return;
        }

        // 拖到任务 → 改为其子任务（改层级）
        const dropInfo = findTaskProject(taskStore.nodes, dropUri);
        if (!dropInfo) return;
        if (dragInfo.project !== dropInfo.project) {
            notificationStore.addToast("error", "只能在同一项目内拖动");
            return;
        }
        if (dropUri === dragInfo.parent) return; // 拖到直接父级：无需改动
        try {
            await diyService.diy.task.move({ uri: dragUri, parent: dropUri });
            await taskStore.loadTree();
            setExpanded((prev) => new Set(prev).add(dropUri)); // 展开 drop 目标，子级立即可见
            notificationStore.addToast("success", "已调整层级");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToast("error", `调整失败: ${msg}`);
        }
    };

    return (
        <DragDropProvider onDragEnd={handleDragEnd} sensors={[PointerSensor]}>
            <div class="h-full flex flex-col">
                <div class={`flex items-center gap-2 px-3 ${VIEW_BAR_H} border-b shrink-0`}>
                    <span class="text-sm font-semibold shrink-0">任务</span>
                    {/* 搜索框：宽度随容器伸缩，但保底能看清几个词 */}
                    <input
                        ref={bindSearch}
                        type="search"
                        class="input input-bordered input-xs flex-1 min-w-24 max-w-72"
                        placeholder="搜索标题 / 编号 / 正文…（⌘F）"
                        value={query()}
                        onInput={(e) => applyQuery(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            // ↑/↓/Enter 在搜索框里 = 在命中之间跳（与编辑器 find bar 同）
                            if (e.key === "Enter" || e.key === "ArrowDown") {
                                e.preventDefault();
                                gotoHit(focusIdx() + 1);
                            } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                gotoHit(focusIdx() - 1);
                            } else if (e.key === "Escape") {
                                e.preventDefault();
                                applyQuery("");
                            }
                        }}
                    />
                    <Show when={!searching()}>
                        <span class="ml-auto">
                            <CreateProjectSheet />
                        </span>
                    </Show>
                </div>

                {/* 搜索结果条：有搜索词就是"有上下文"，故搜索态下恒显示（含 0/0 无命中）。
                    复用提示场的 DynamicBar 形态（find bar：↑ ↓ i/n + 当前项 + ✕）。 */}
                <Show when={searching()}>
                    <DynamicBar
                        label={
                            hits().length === 0
                                ? `没有匹配「${query().trim()}」的任务`
                                : (rows().find((r) => r.key === focusUri())?.node.title ?? focusUri())
                        }
                        count={hits().length}
                        index={focusIdx()}
                        onPrev={() => gotoHit(focusIdx() - 1)}
                        onNext={() => gotoHit(focusIdx() + 1)}
                        onClear={() => applyQuery("")}
                    />
                </Show>

                <div class="flex-1 overflow-auto min-w-0" tabindex={0} onKeyDown={handleKeyDown} ref={scrollRef} onScroll={onScroll}>
                    <table class="table table-sm w-full">
                        <thead class="sticky top-0 bg-base-100 z-10">
                            {/* 表头**整行由 SORT_KEYS 生成**：清单既是列顺序也是可排序键的唯一真相源。
                                曾经这里逐列手写、标题列写死为不可排序的 <th>，而 SORT_KEYS 里偏偏
                                有 title（SORT_KEY_SET 还额外手工补过一次）—— 两处真相源必然对不上。 */}
                            <tr>
                                <For each={SORT_KEYS}>
                                    {(col) => (
                                        <SortableTh
                                            sortKey={col.key}
                                            sort={sort()}
                                            onSort={applySort}
                                            class={col.key === "title" ? "min-w-[220px]" : ""}
                                        />
                                    )}
                                </For>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={rows()}>
                                {(row) =>
                                    row.kind === "project" ? (
                                        <ProjectRow row={row} expanded={expanded()} onToggle={toggle} />
                                    ) : (
                                        <TaskRow
                                            row={row}
                                            expanded={expanded()}
                                            onToggle={toggle}
                                            focused={searching() && row.key === focusUri()}
                                        />
                                    )
                                }
                            </For>
                            <Show when={!taskStore.loading && rows().length === 0}>
                                <tr>
                                    <td colspan={SORT_KEYS.length} class="text-center opacity-60 py-8">
                                        {searching() ? `没有匹配「${query().trim()}」的任务` : "暂无任务"}
                                    </td>
                                </tr>
                            </Show>
                        </tbody>
                    </table>
                </div>
            </div>

            {/* dnd-kit DragOverlay：拖拽幽灵只显示任务标题 */}
            <DragOverlay>
                {(source) =>
                    source?.data?.title ? (
                        <div class="flex items-center px-3 py-1 text-sm bg-base-100 border rounded shadow-lg opacity-80 max-w-[200px] pointer-events-none select-none">
                            <span class="truncate">{String(source.data.title)}</span>
                            <span class="ml-2 text-xs opacity-60">拖放改层级</span>
                        </div>
                    ) : null
                }
            </DragOverlay>
        </DragDropProvider>
    );
}

function ProjectRow(props: { row: FlatRow; expanded: Set<string>; onToggle: (k: string) => void }) {
    const { row } = props;
    // 项目节点作为拖放目标：拖到其上 → 子任务提升为该项目一级任务
    const drop = useDroppable({
        get id() {
            return row.key;
        },
    });
    const ref = (el: Element | undefined) => drop.ref(el);
    return (
        <tr
            ref={ref}
            class={`bg-base-200 hover:bg-base-300 border-b transition-colors ${drop.isDropTarget() ? " ring-2 ring-primary/50 ring-inset" : ""}`}
        >
            <td style={`padding-left:${8 + row.depth * 20}px`} class="font-semibold">
                <span class="inline-flex items-center gap-1">
                    {row.node.children?.length ? (
                        <button
                            class="btn btn-ghost btn-xs p-0 w-5 min-w-0 shrink-0 justify-center items-center"
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onToggle(row.key);
                            }}
                        >
                            {props.expanded.has(row.key) ? "›" : "⌄"}
                        </button>
                    ) : (
                        <span class="w-5" />
                    )}
                    <span>📁</span>
                    <span
                        class="truncate cursor-pointer"
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onToggle(row.key);
                        }}
                    >
                        {row.node.title}
                    </span>
                    <CreateTaskSheet projectId={row.projectId} projectLabel={row.node.title ?? ""} />
                </span>
            </td>
            {/* 项目行的其余列：项目路径（原 URI 列的语义，项目自身没有任务字段） */}
            <td colspan={7} class="font-mono text-xs opacity-60 truncate">
                {row.node.project_path ?? ""}
            </td>
        </tr>
    );
}

function TaskRow(props: { row: FlatRow; expanded: Set<string>; onToggle: (k: string) => void; focused: boolean }) {
    const { row } = props;
    const isSelected = () => taskStore.selectedUri === row.key;
    const drag = useDraggable({
        get id() {
            return row.key;
        },
        // getter：dnd-kit/solid 在 createEffect 里读 input.data，保持对 node 的追踪，
        // 行对象缓存后改名能让拖拽幽灵标题跟着刷新（否则会停在首次构建时的标题）
        get data() {
            return { title: row.node.title ?? row.key, kind: "task" };
        },
    });
    const drop = useDroppable({
        get id() {
            return row.key;
        },
    });
    const ref = (el: Element | undefined) => {
        drag.ref(el);
        drop.ref(el);
    };

    return (
        <tr
            ref={ref}
            data-uri={row.key}
            class={`border-b transition-colors select-none ${
                isSelected()
                    ? "bg-primary/20"
                    : "hover:bg-base-200" + (drop.isDropTarget() ? " ring-2 ring-primary/50 ring-inset" : "")
            } ${props.focused ? " outline outline-1 outline-warning/70 -outline-offset-1" : ""}`}
        >
            <td style={`padding-left:${8 + row.depth * 20}px`}>
                <span class="inline-flex items-center gap-1">
                    {row.node.children?.length ? (
                        <button
                            class="btn btn-ghost btn-xs p-0 w-5 min-w-0 shrink-0 justify-center items-center"
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onToggle(row.key);
                            }}
                        >
                            {props.expanded.has(row.key) ? "⌄" : "›"}
                        </button>
                    ) : (
                        <span class="w-5" />
                    )}
                    <span class={`w-2 h-2 rounded-full inline-block ${taskStateColor(row.node.state)}`} />
                    {/* 任务号前置：一眼定位「几号任务」，且与 URI 列的末段同源（都来自 main 的 num）。
                        弱化成 mono/半透明，避免与标题抢视觉焦点；标题过长时它不参与 truncate。 */}
                    <Show when={row.node.num}>
                        <span class="shrink-0 font-mono text-xs opacity-50">#{row.node.num}</span>
                    </Show>
                    <span
                        class="truncate font-medium diy-link underline-offset-2 hover:underline cursor-pointer"
                        onClick={(e) => {
                            e.stopPropagation();
                            // 再点同一个任务 → 收起面板；否则切到该任务
                            taskStore.selectTask(taskStore.selectedUri === row.key ? null : row.key);
                        }}
                    >
                        {row.node.title}
                    </span>
                    <CreateTaskSheet projectId={row.projectId} projectLabel={row.node.title ?? ""} parentUri={row.key} compact />
                </span>
                {/* 正文命中片段：行内第二行（不新增 <tr>，否则树的行序/键盘导航要重新定义）。
                    纯文本单行展示——不做 Markdown 渲染：片段是"定位线索"，渲染只会增加噪音。 */}
                <Show when={row.snippet}>
                    {(s) => (
                        <div class="text-xs opacity-60 truncate leading-tight" title={`${s().before}${s().match}${s().after}`}>
                            <span>{s().before}</span>
                            <mark class="bg-warning/40 text-inherit rounded-sm px-0.5">{s().match}</mark>
                            <span>{s().after}</span>
                            <Show when={s().count > 1}>
                                <span class="ml-1 opacity-70">+{s().count - 1} 处</span>
                            </Show>
                        </div>
                    )}
                </Show>
            </td>
            <td class="text-xs">
                <Show when={row.node.change_type} fallback={<Dash />}>
                    {(v) => <span class="font-mono opacity-80">{v()}</span>}
                </Show>
            </td>
            <td class="text-xs">
                <Show when={row.node.module} fallback={<Dash />}>
                    {(v) => <span class="font-mono opacity-80 truncate inline-block max-w-40 align-bottom">{v()}</span>}
                </Show>
            </td>
            <td class="text-xs whitespace-nowrap">
                <Show when={row.node.priority} fallback={<Dash />}>
                    {(v) => <span class={`badge badge-sm font-mono ${priorityClass(v())}`}>{v()}</span>}
                </Show>
            </td>
            <td class="text-xs">
                <StateSelector uri={row.key} state={row.node.state ?? ""} />
            </td>
            <td class="text-xs font-mono opacity-60">{row.node.num ?? ""}</td>
            <td class="text-xs whitespace-nowrap opacity-70" title={row.node.created ?? ""}>
                {fmtTime(row.node.created)}
            </td>
            <td class="text-xs whitespace-nowrap opacity-70" title={row.node.updated ?? ""}>
                {fmtTime(row.node.updated)}
            </td>
        </tr>
    );
}
