// @ts-nocheck
import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { diyService } from "../lib/rpc";
import { CreateProjectSheet } from "./CreateProjectSheet";
import { CreateTaskSheet } from "./CreateTaskSheet";

const stateColor: any = {
    pending: "bg-warning",
    active: "bg-info",
    done: "bg-success",
    blocked: "bg-error",
    cancelled: "bg-neutral",
};

function flattenTree(nodes: any[], expanded: Set<string>, depth = 0) {
    const rows: any[] = [];
    for (const n of nodes) {
        const key = n.kind === "project" ? `proj:${n.project}` : n.uri;
        rows.push({ key, kind: n.kind, node: n, depth, projectId: n.project ?? "" });
        const shouldExpand = n.kind === "project" ? !expanded.has(key) : expanded.has(key);
        if (shouldExpand && n.children?.length)
            rows.push(...flattenTree(n.children, expanded, depth + 1));
    }
    return rows;
}

// 找任务所属项目 + 直接父级（拖拽校验用）
function findTaskProject(nodes: any[], uri: string) {
    for (const p of nodes) {
        if (p.kind !== "project") continue;
        const f = findInTree(p.children, uri);
        if (f) return { project: p.project ?? "", parent: f.parentUri };
    }
    return null;
}
function findInTree(children: any[], uri: string) {
    for (const c of children) {
        if (c.uri === uri) return c;
        const f = findInTree(c.children, uri);
        if (f) return f;
    }
    return null;
}
function findInAll(nodes: any[], uri: string) {
    for (const n of nodes) {
        if (n.uri === uri) return n;
        const f = findInTree(n.children, uri);
        if (f) return f;
    }
    return null;
}

export function TaskTree() {
    const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
    const [dragUri, setDragUri] = createSignal<string | null>(null);
    const [dropOver, setDropOver] = createSignal<string | null>(null);
    onMount(() => taskStore.loadTree());
    const rows = createMemo(() => flattenTree(taskStore.nodes as any, expanded()));
    const selectable = createMemo(() =>
        rows()
            .filter((r: any) => r.kind === "task")
            .map((r: any) => r.key),
    );
    const toggle = (k: string) =>
        setExpanded((p) => {
            const n = new Set(p);
            n.has(k) ? n.delete(k) : n.add(k);
            return n;
        });
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const cur = selectable().indexOf(taskStore.selectedUri as string);
        const next =
            e.key === "ArrowDown"
                ? cur < selectable().length - 1 ? cur + 1 : 0
                : cur > 0 ? cur - 1 : selectable().length - 1;
        if (selectable()[next]) taskStore.selectTask(selectable()[next]);
    };

    // ── 拖拽改父级（原生 HTML5 DnD，镜像 React dnd-kit 的 task.move 逻辑）──
    const handleDrop = async (dropUri: string) => {
        const drag = dragUri();
        setDragUri(null);
        setDropOver(null);
        if (!drag || drag === dropUri) return;
        const dragInfo = findTaskProject(taskStore.nodes as any, drag);
        const dropInfo = findTaskProject(taskStore.nodes as any, dropUri);
        if (!dragInfo || !dropInfo) return;
        if (dragInfo.project !== dropInfo.project) {
            notificationStore.addToast("error", "只能在同一项目内拖动");
            return;
        }
        if (dropUri === dragInfo.parent) return; // 拖到直接父级：无需改动
        try {
            await diyService.diy.task.move({ uri: drag, parent: dropUri });
            await taskStore.loadTree();
            notificationStore.addToast("success", "已调整层级");
        } catch (e: any) {
            notificationStore.addToast("error", `调整失败: ${e?.message ?? e}`);
        }
    };

    const dragGhost = createMemo(() => {
        const uri = dragUri();
        if (!uri) return null;
        const task = findInAll(taskStore.nodes as any, uri);
        return task ?? null;
    });

    return (
        <div class="h-full flex flex-col">
            <div class="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
                <span class="text-sm font-semibold">任务</span>
                <CreateProjectSheet />
            </div>
            <div class="flex-1 overflow-auto min-w-0" tabindex={0} onKeyDown={handleKeyDown}>
                <table class="table table-sm w-full">
                    <thead class="sticky top-0 bg-base-100 z-10">
                        <tr>
                            <th class="w-[50%]">标题</th>
                            <th class="w-[30%]">URI</th>
                            <th class="w-[20%]">状态</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={rows()}>
                            {(row: any) =>
                                row.kind === "project" ? (
                                    <tr class="bg-base-200 hover:bg-base-300 border-b">
                                        <td style={`padding-left:${8 + row.depth * 20}px`} class="font-semibold">
                                            <span class="inline-flex items-center gap-1">
                                                {row.node.children?.length ? (
                                                    <button
                                                        class="btn btn-ghost btn-xs p-0"
                                                        onClick={() => toggle(row.key)}
                                                    >
                                                        {expanded().has(row.key) ? "›" : "⌄"}
                                                    </button>
                                                ) : (
                                                    <span class="w-5" />
                                                )}
                                                <span>📁</span>
                                                <span class="truncate cursor-pointer" onClick={() => toggle(row.key)}>
                                                    {row.node.title}
                                                </span>
                                                <CreateTaskSheet
                                                    projectId={row.projectId}
                                                    projectLabel={row.node.title ?? ""}
                                                />
                                            </span>
                                        </td>
                                        <td class="font-mono text-xs opacity-60">{row.node.project}</td>
                                        <td />
                                    </tr>
                                ) : (
                                    <tr
                                        draggable={true}
                                        onDragStart={() => setDragUri(row.key)}
                                        onDragEnd={() => {
                                            setDragUri(null);
                                            setDropOver(null);
                                        }}
                                        onDragOver={(e) => {
                                            e.preventDefault();
                                            setDropOver(row.key);
                                        }}
                                        onDragLeave={() => setDropOver((prev) => (prev === row.key ? null : prev))}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            handleDrop(row.key);
                                        }}
                                        class={`border-b cursor-pointer transition-colors ${
                                            taskStore.selectedUri === row.key
                                                ? "bg-primary/20"
                                                : "hover:bg-base-200" +
                                                  (dropOver() === row.key && dragUri()
                                                      ? " ring-2 ring-primary/50 ring-inset"
                                                      : "")
                                        }`}
                                        onClick={() => taskStore.selectTask(row.key)}
                                    >
                                        <td style={`padding-left:${8 + row.depth * 20}px`}>
                                            <span class="inline-flex items-center gap-1">
                                                {row.node.children?.length ? (
                                                    <button
                                                        class="btn btn-ghost btn-xs p-0"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            toggle(row.key);
                                                        }}
                                                    >
                                                        {expanded().has(row.key) ? "⌄" : "›"}
                                                    </button>
                                                ) : (
                                                    <span class="w-5" />
                                                )}
                                                <span
                                                    class={`w-2 h-2 rounded-full inline-block ${stateColor[row.node.state] ?? "bg-neutral"}`}
                                                />
                                                <span class="truncate font-medium">{row.node.title}</span>
                                                {row.node.starred && <span>⭐</span>}
                                                <CreateTaskSheet
                                                    projectId={row.projectId}
                                                    projectLabel={row.node.title ?? ""}
                                                    parentUri={row.key}
                                                    compact
                                                />
                                            </span>
                                        </td>
                                        <td class="font-mono text-xs opacity-60 truncate">{row.key}</td>
                                        <td class="text-xs opacity-60">{row.node.state}</td>
                                    </tr>
                                )
                            }
                        </For>
                        <Show when={!taskStore.loading && rows().length === 0}>
                            <tr>
                                <td colspan={3} class="text-center opacity-60 py-8">
                                    暂无任务
                                </td>
                            </tr>
                        </Show>
                    </tbody>
                </table>
            </div>

            {/* 拖拽浮层 */}
            <Show when={dragGhost()}>
                <div class="fixed left-4 top-4 z-[100] flex items-center px-3 py-1 text-sm bg-base-100 border rounded shadow-lg opacity-80 max-w-[200px] pointer-events-none">
                    <span class="truncate">{dragGhost()?.title}</span>
                    <span class="ml-2 text-xs opacity-60">拖动改层级</span>
                </div>
            </Show>
        </div>
    );
}