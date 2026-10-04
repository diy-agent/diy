/**
 * NavSearch — nav 里的「⌘K 快速打开会话」弹层。
 *
 * 需求（##254）：打开会话的路径过长（任务管理 → 搜索 → 点标题 → 点会话）。
 * 这里给一条一步到位的路：⌘K → 敲词 → ↑↓ → Enter，**直接落到会话 tab**，
 * 不经过任务管理详情。
 *
 * 三条刻意的选择：
 *  1. **结果单位是任务（= 会话）**：diy 里任务与会话 1:1（打开会话 = 开该任务的
 *     task-run tab），故不造「任务条目 + 会话条目」两份数据，去重靠 tabStore.open
 *     自身的语义（已开则只聚焦，不新开）。
 *  2. **搜索口径与任务管理页同源**（shared/task-list 的 matchTask/buildSnippet，
 *     排序见 shared/nav-search）：同一个词在两个入口命中同一批，不会各写一套。
 *  3. **每次打开都是干净的一次**：输入清空、聚焦、选中归零 —— 上次的词还留着会
 *     让"直接打字"变成"先删干净"。
 *
 * 非目标（弹层范围，父任务 ##254 已定）：不搜项目 / 设置项 / CLI 命令，不做
 * `-` 排除等查询语法 —— 本功能是"快速定位"，不是查询语言。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { searchTasks } from "../../shared/nav-search";
import { taskStateColor } from "../../main/core/task-state";
import { taskStore } from "../store/taskStore";
import { tabStore } from "../store/tabStore";
import { findNode } from "../lib/task-lineage";

/** 结果项 → 任务号（节点可能已不在树里 —— 树是异步刷新的） */
const numOf = (uri: string): string | undefined => findNode(taskStore.nodes, uri)?.num;

/** 该任务此刻是否已开着会话 tab（用于「已打开」徽标） */
const hasOpenSession = (uri: string): boolean =>
    tabStore.opened.some((t) => t.pageId === "task-run" && t.ctx === uri);

function Panel(props: { onClose: () => void; onPick: (uri: string) => void }) {
    const [query, setQuery] = createSignal("");
    const [active, setActive] = createSignal(0);
    let inputEl: HTMLInputElement | undefined;
    let listEl: HTMLUListElement | undefined;

    const hits = createMemo(() => searchTasks(taskStore.nodes, query()));

    /** 换词 → 选中归零（否则旧下标指向新列表里的别的任务） */
    createEffect(() => {
        query();
        setActive(0);
    });

    const move = (delta: number) => {
        const n = hits().length;
        if (n === 0) return;
        setActive((a) => ((a + delta) % n + n) % n);
    };

    const pick = (i: number) => {
        const hit = hits()[i];
        if (!hit) return;
        props.onPick(hit.node.uri!);
        props.onClose();
    };

    onMount(() => {
        inputEl?.focus();
        // 点背景关闭：用 window 层的 Esc 兜住「焦点不在输入框」的情形（列表点击后焦点会走）
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    /** 选中项滚进可视区（键盘导航时列表可能比容器长） */
    createEffect(() => {
        const i = active();
        const el = listEl?.querySelector<HTMLElement>(`[data-index="${i}"]`);
        el?.scrollIntoView({ block: "nearest" });
    });

    return (
        <div
            class="fixed inset-0 z-[100] flex items-start justify-center bg-neutral/40 pt-[12vh]"
            data-testid="nav-search-overlay"
            onClick={props.onClose}
        >
            <div
                class="flex flex-col rounded-xl border border-base-300 bg-base-100 shadow-2xl overflow-hidden"
                style={{ width: "min(560px, 90vw)" }}
                data-testid="nav-search-panel"
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={(el) => (inputEl = el)}
                    data-testid="nav-search-input"
                    class="w-full border-b border-base-300 bg-transparent px-3 py-2 text-prose outline-none placeholder:opacity-50"
                    placeholder="搜索任务 / 会话（↑↓ 选择，Enter 打开）"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            move(1);
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            move(-1);
                        } else if (e.key === "Enter") {
                            e.preventDefault();
                            pick(active());
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            props.onClose();
                        }
                    }}
                />
                <ul ref={(el) => (listEl = el)} class="max-h-[50vh] overflow-auto py-1" data-testid="nav-search-list">
                    <Show
                        when={hits().length > 0}
                        fallback={
                            <li class="px-3 py-3 text-body opacity-50">
                                {query().trim() ? "没有匹配的任务" : "输入关键词搜索任务（标题 / 编号 / 正文…）"}
                            </li>
                        }
                    >
                        <For each={hits()}>
                            {(hit, i) => (
                                <li>
                                    <button
                                        data-testid="nav-search-item"
                                        data-index={i()}
                                        data-uri={hit.node.uri}
                                        class={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors ${
                                            i() === active() ? "bg-primary/25" : "hover:bg-base-200"
                                        }`}
                                        onMouseEnter={() => setActive(i())}
                                        onClick={() => pick(i())}
                                    >
                                        <span class="flex w-full items-center gap-2">
                                            <span
                                                class={`h-1.5 w-1.5 shrink-0 rounded-full ${taskStateColor(hit.node.state)}`}
                                            />
                                            <span class="shrink-0 font-mono text-caption opacity-60">
                                                #{numOf(hit.node.uri!) ?? hit.node.num}
                                            </span>
                                            <span class="min-w-0 flex-1 truncate text-body">
                                                {hit.node.title ?? hit.node.uri}
                                            </span>
                                            <Show when={hit.node.project_label || hit.node.project}>
                                                <span class="shrink-0 text-caption opacity-50">
                                                    {hit.node.project_label ?? hit.node.project}
                                                </span>
                                            </Show>
                                            <Show when={hasOpenSession(hit.node.uri!)}>
                                                <span class="shrink-0 text-caption opacity-60">已打开</span>
                                            </Show>
                                        </span>
                                        {/* 正文命中：就地展示片段（与任务管理页同一 snippet 形状） */}
                                        <Show when={hit.snippet}>
                                            {(s) => (
                                                <span class="w-full truncate text-caption opacity-60">
                                                    {s().before}
                                                    <mark class="bg-transparent text-base-content font-semibold">
                                                        {s().match}
                                                    </mark>
                                                    {s().after}
                                                    <Show when={s().count > 1}>
                                                        <span class="opacity-60"> +{s().count - 1} 处</span>
                                                    </Show>
                                                </span>
                                            )}
                                        </Show>
                                    </button>
                                </li>
                            )}
                        </For>
                    </Show>
                </ul>
                <div class="border-t border-base-300 px-3 py-1 text-caption opacity-50">
                    {hits().length > 0 ? `${hits().length} 条` : ""} · Enter 打开会话 · Esc 关闭 · ⌘K 开关
                </div>
            </div>
        </div>
    );
}

export function NavSearch(props: { open: boolean; onClose: () => void; onPick: (uri: string) => void }) {
    return (
        <Show when={props.open}>
            <Panel onClose={props.onClose} onPick={props.onPick} />
        </Show>
    );
}
