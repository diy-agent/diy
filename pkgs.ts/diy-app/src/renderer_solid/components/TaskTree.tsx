import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable, PointerSensor } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { taskStore, type TreeNode } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { diyService } from "../lib/rpc";
import { CreateProjectSheet } from "./CreateProjectSheet";
import { CreateTaskSheet } from "./CreateTaskSheet";

// dnd-kit/solid 未直接导出 DragEndEvent，从 onDragEnd 回调参数提取
type DragEndEvent = Parameters<NonNullable<DragDropProviderProps["onDragEnd"]>>[0];

const stateColor: Record<string, string> = {
    pending: "bg-warning",
    active: "bg-info",
    done: "bg-success",
    blocked: "bg-error",
    cancelled: "bg-neutral",
};

interface FlatRow {
    key: string;
    kind: "project" | "task";
    node: TreeNode;
    depth: number;
    projectId: string;
}

function flattenTree(nodes: TreeNode[], expanded: Set<string>, depth = 0): FlatRow[] {
    const rows: FlatRow[] = [];
    for (const n of nodes) {
        const key = n.kind === "project" ? `proj:${n.project}` : n.uri ?? "";
        rows.push({ key, kind: n.kind, node: n, depth, projectId: n.project ?? "" });
        const shouldExpand = n.kind === "project" ? !expanded.has(key) : expanded.has(key);
        if (shouldExpand && n.children?.length)
            rows.push(...flattenTree(n.children, expanded, depth + 1));
    }
    return rows;
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

export function TaskTree() {
    const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
    onMount(() => taskStore.loadTree());
    const rows = createMemo(() => flattenTree(taskStore.nodes, expanded()));
    const selectable = createMemo(() =>
        rows()
            .filter((r) => r.kind === "task")
            .map((r) => r.key),
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
        const next = e.key === "ArrowDown" ? (cur < selectable().length - 1 ? cur + 1 : 0) : cur > 0 ? cur - 1 : selectable().length - 1;
        if (selectable()[next]) taskStore.selectTask(selectable()[next]);
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
                                {(row) =>
                                    row.kind === "project" ? (
                                        <ProjectRow row={row} expanded={expanded()} onToggle={toggle} />
                                    ) : (
                                        <TaskRow row={row} expanded={expanded()} onToggle={toggle} />
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
                        <button class="btn btn-ghost btn-xs p-0" onClick={() => props.onToggle(row.key)}>
                            {props.expanded.has(row.key) ? "›" : "⌄"}
                        </button>
                    ) : (
                        <span class="w-5" />
                    )}
                    <span>📁</span>
                    <span class="truncate cursor-pointer" onClick={() => props.onToggle(row.key)}>
                        {row.node.title}
                    </span>
                    <CreateTaskSheet projectId={row.projectId} projectLabel={row.node.title ?? ""} />
                </span>
            </td>
            <td class="font-mono text-xs opacity-60">{row.node.project}</td>
            <td />
        </tr>
    );
}

function TaskRow(props: { row: FlatRow; expanded: Set<string>; onToggle: (k: string) => void }) {
    const { row } = props;
    const isSelected = () => taskStore.selectedUri === row.key;
    const drag = useDraggable({
        get id() {
            return row.key;
        },
        data: { title: row.node.title ?? row.key, kind: "task" },
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
            class={`border-b cursor-pointer transition-colors select-none ${
                isSelected() ? "bg-primary/20" : "hover:bg-base-200" + (drop.isDropTarget() ? " ring-2 ring-primary/50 ring-inset" : "")
            }`}
            onClick={(e) => {
                e.stopPropagation();
                taskStore.selectTask(row.key);
            }}
        >
            <td style={`padding-left:${8 + row.depth * 20}px`}>
                <span class="inline-flex items-center gap-1">
                    {row.node.children?.length ? (
                        <button
                            class="btn btn-ghost btn-xs p-0"
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
                    <span class={`w-2 h-2 rounded-full inline-block ${stateColor[row.node.state ?? ""] ?? "bg-neutral"}`} />
                    <span class="truncate font-medium">{row.node.title}</span>
                    {row.node.starred && <span>⭐</span>}
                    <CreateTaskSheet projectId={row.projectId} projectLabel={row.node.title ?? ""} parentUri={row.key} compact />
                </span>
            </td>
            <td class="font-mono text-xs opacity-60 truncate">{row.key}</td>
            <td class="text-xs opacity-60">{row.node.state}</td>
        </tr>
    );
}
