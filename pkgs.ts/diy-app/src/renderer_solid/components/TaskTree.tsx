// @ts-nocheck
import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/solid";
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

export function TaskTree() {
    const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
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
        const next = e.key === "ArrowDown" ? (cur < selectable().length - 1 ? cur + 1 : 0) : cur > 0 ? cur - 1 : selectable().length - 1;
        if (selectable()[next]) taskStore.selectTask(selectable()[next]);
    };

    // ── dnd-kit/solid 拖拽改父级（与 React dnd-kit 同源）──
    const handleDragEnd = async (event: any) => {
        if (event.operation?.canceled) return;
        const dragUri = event.operation?.source?.id;
        const dropUri = event.operation?.target?.id;
        if (!dragUri || !dropUri || dragUri === dropUri) return;
        const dragInfo = findTaskProject(taskStore.nodes as any, String(dragUri));
        const dropInfo = findTaskProject(taskStore.nodes as any, String(dropUri));
        if (!dragInfo || !dropInfo) return;
        if (dragInfo.project !== dropInfo.project) {
            notificationStore.addToast("error", "只能在同一项目内拖动");
            return;
        }
        if (String(dropUri) === dragInfo.parent) return; // 拖到直接父级：无需改动
        try {
            await diyService.diy.task.move({ uri: String(dragUri), parent: String(dropUri) });
            await taskStore.loadTree();
            setExpanded((prev) => new Set(prev).add(String(dropUri))); // 展开 drop 目标，子级立即可见
            notificationStore.addToast("success", "已调整层级");
        } catch (e: any) {
            notificationStore.addToast("error", `调整失败: ${e?.message ?? e}`);
        }
    };

    return (
        <DragDropProvider onDragEnd={handleDragEnd}>
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
                {(source: any) =>
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

function ProjectRow(props: { row: any; expanded: Set<string>; onToggle: (k: string) => void }) {
    const { row } = props;
    return (
        <tr class="bg-base-200 hover:bg-base-300 border-b">
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

function TaskRow(props: { row: any; expanded: Set<string>; onToggle: (k: string) => void }) {
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
            onClick={() => taskStore.selectTask(row.key)}
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
                    <span class={`w-2 h-2 rounded-full inline-block ${stateColor[row.node.state] ?? "bg-neutral"}`} />
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