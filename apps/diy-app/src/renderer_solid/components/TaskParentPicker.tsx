/**
 * TaskParentPicker — 从任务树里**挑一个任务**的模态选择器（##356 ①）。
 *
 * 一个组件两处用，因为两处的差别只在「挑来干什么」：
 *   1. 任务详情「重设父节点」：挑一个任务当**父**（`allowRoot` 提供「提升为一级任务」项）
 *   2. 任务树层级菜单「添加已有任务为子任务」：挑一个任务当**子**
 * 落点都是 `diy.task.move`，校验（父存在 / 同项目 / 防环）全在 main 的 updateTask，
 * 本组件只做**体验层**的排除（把必然非法的候选项灰掉，别让用户点了才报错）。
 *
 * 为什么不复用 nav 的 ⌘K 搜索弹层：那个的结果单位是「打开会话」（点中即开会话 tab），
 * 这里是「选一个任务本体」——语义不同，且这里要**树形缩进**（否则一堆同名任务无从分辨）。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { taskStore, type TreeNode } from "../store/taskStore";
import { taskStateColor } from "../../main/core/task-state";

/** 带缩进的行（picker 自己 DFS：要的是"树形候选"，与任务表的剪枝/排序逻辑无关） */
interface PickerRow {
    uri: string;
    title: string;
    num?: string;
    state?: string;
    depth: number;
    /** 不可选（自己 / 自己的子孙）—— 父子互换会成环，main 也会拒 */
    disabled: boolean;
}

/** 收集某任务的整棵子树（含自身）—— 防环的**唯一**排除集 */
function subtreeOf(nodes: TreeNode[], root: string): Set<string> {
    const out = new Set<string>();
    const find = (ns: TreeNode[]): TreeNode | null => {
        for (const n of ns) {
            if (n.uri === root) return n;
            const hit = find(n.children ?? []);
            if (hit) return hit;
        }
        return null;
    };
    const node = find(nodes);
    const walk = (n: TreeNode) => {
        if (n.uri) out.add(n.uri);
        for (const c of n.children ?? []) walk(c);
    };
    if (node) walk(node);
    return out;
}

/**
 * 平铺某个项目的任务（树序 + 深度）。
 * 项目节点没有 uri，故以 `n.project === project` 认领它的子树。
 */
function flattenProject(nodes: TreeNode[], project: string): PickerRow[] {
    const out: PickerRow[] = [];
    const walk = (ns: TreeNode[], depth: number) => {
        for (const n of ns) {
            if (n.kind === "task" && n.uri) {
                out.push({
                    uri: n.uri,
                    title: n.title ?? n.uri,
                    num: n.num,
                    state: n.state,
                    depth,
                    disabled: false,
                });
            }
            walk(n.children ?? [], n.kind === "task" ? depth + 1 : depth);
        }
    };
    const proj = nodes.find((p) => p.kind === "project" && (p.project ?? "") === project);
    // 找不到项目节点（树未加载完）时退化为整棵树 —— 宁可多列几项，也不给一个空列表
    walk(proj ? (proj.children ?? []) : nodes, 0);
    return out;
}

export function TaskParentPicker(props: {
    open: boolean;
    onClose: () => void;
    title: string;
    /** 候选限定在该项目（`diy.task.move` 只允许同项目） */
    project: string;
    /** 不可选的子树根（自己）：自身 + 子孙灰掉 —— 重设父 / 添加为子都必须排除 */
    excludeSubtreeOf: string;
    /** 是否提供「（无）提升为一级任务」项（重设父节点才有意义） */
    allowRoot?: boolean;
    /** 选中：`""` = 提升为一级任务（仅 allowRoot 时可能出现）。
     *  可返回 Promise（move 是异步的）：关闭弹层由调用方在它落地后做（本组件不猜） */
    onPick: (uri: string) => void | Promise<void>;
}) {
    const [query, setQuery] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    let inputEl: HTMLInputElement | undefined;

    /** 候选（数据变了自动重算；query 只过滤、不改树的形状） */
    const rows = createMemo<PickerRow[]>(() => {
        const exclude = subtreeOf(taskStore.nodes, props.excludeSubtreeOf);
        const q = query().trim().toLowerCase();
        return flattenProject(taskStore.nodes, props.project)
            .map((r) => ({ ...r, disabled: exclude.has(r.uri) }))
            .filter((r) => !q || `${r.num ?? ""} ${r.title}`.toLowerCase().includes(q));
    });

    const pick = (uri: string) => {
        if (busy()) return; // 双击防重入：一次选择只发一次 move
        setBusy(true);
        // 关闭交给调用方（它在 move 落地后关）——这里只负责不重复提交
        void Promise.resolve(props.onPick(uri)).finally(() => setBusy(false));
    };

    // Esc 关弹层：捕获阶段 + stopPropagation，与 ConfirmDialog / NavSearch 同款 ——
    // 一次 Esc 只关一层，不把背后的任务详情面板一起关掉（TaskDetailPanel 在 window 上听 Esc）。
    onMount(() => {
        inputEl?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            props.onClose();
        };
        document.addEventListener("keydown", onKey, true);
        onCleanup(() => document.removeEventListener("keydown", onKey, true));
    });

    return (
        <Show when={props.open}>
            <div
                class="fixed inset-0 z-[120] flex items-start justify-center bg-neutral/40 pt-[14vh]"
                data-testid="task-parent-picker"
                onClick={props.onClose}
            >
                <div
                    class="flex max-h-[70vh] w-[min(520px,92vw)] flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
                    role="dialog"
                    aria-modal="true"
                    aria-label={props.title}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class="border-b border-base-300 px-3 py-2 text-prose font-semibold">{props.title}</div>
                    <input
                        ref={(el) => (inputEl = el)}
                        class="w-full border-b border-base-300 bg-transparent px-3 py-2 text-prose outline-none placeholder:opacity-50"
                        placeholder="过滤任务（标题 / 编号）"
                        value={query()}
                        onInput={(e) => setQuery(e.currentTarget.value)}
                    />
                    <ul class="overflow-auto py-1" data-testid="task-parent-picker-list">
                        <Show when={props.allowRoot}>
                            <li>
                                <button
                                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body hover:bg-base-200"
                                    data-testid="task-parent-picker-root"
                                    onClick={() => pick("")}
                                >
                                    <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-base-content/30" />
                                    <span>（无）提升为一级任务</span>
                                </button>
                            </li>
                        </Show>
                        <For each={rows()}>
                            {(r) => (
                                <li>
                                    <button
                                        class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-body ${
                                            r.disabled ? "opacity-30 cursor-not-allowed" : "hover:bg-base-200"
                                        }`}
                                        data-testid="task-parent-picker-item"
                                        data-uri={r.uri}
                                        disabled={r.disabled}
                                        title={r.disabled ? "不能选自己或自己的子任务（会成环）" : r.uri}
                                        onClick={() => pick(r.uri)}
                                    >
                                        <span style={{ width: `${r.depth * 12}px` }} class="shrink-0" />
                                        <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${taskStateColor(r.state)}`} />
                                        <span class="shrink-0 font-mono text-caption opacity-60">#{r.num ?? "?"}</span>
                                        <span class="min-w-0 flex-1 truncate">{r.title}</span>
                                    </button>
                                </li>
                            )}
                        </For>
                        <Show when={rows().length === 0}>
                            <li class="px-3 py-3 text-body opacity-50">没有匹配的任务</li>
                        </Show>
                    </ul>
                    <div class="border-t border-base-300 px-3 py-1 text-caption opacity-50">
                        点击即选 · Esc 关闭（{busy() ? "处理中…" : "同项目内"})
                    </div>
                </div>
            </div>
        </Show>
    );
}
