import { onMount, onCleanup, Show } from "solid-js";
import { taskStore, type TaskDetail } from "../store/taskStore";

export function TaskDetailPanel() {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") taskStore.selectTask(null);
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));

    return (
        <Show when={!!taskStore.selectedUri}>
            <div
                class="card bg-base-100 border-l shadow-xl absolute inset-y-0 right-0 z-40 h-full"
                style="width:65%"
                onClick={(e) => e.stopPropagation()}
            >
                {/* 卡片头部 */}
                <div class="card-body p-0">
                    <div class="flex items-center justify-between px-4 py-2 border-b">
                        <span class="text-xs font-mono opacity-60 truncate max-w-[300px]">
                            {taskStore.selectedUri}
                        </span>
                        <button class="btn btn-ghost btn-sm" onClick={() => taskStore.selectTask(null)}>
                            ✕
                        </button>
                    </div>

                    {/* 卡片内容 */}
                    <div class="p-4 overflow-auto">
                        <Show when={taskStore.selectedTask} fallback={<div class="opacity-60 text-sm">加载中…</div>}>
                            {(t) => <TaskDetailView task={t()} />}
                        </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
}

function TaskDetailView(props: { task: TaskDetail }) {
    const t = props.task;
    return (
        <div class="space-y-4">
            <div>
                <h2 class="text-lg font-bold mb-1">
                    {t.title || t.uri}
                </h2>
                {t.state && <span class="badge badge-sm">{t.state}</span>}
            </div>
            <div class="flex gap-2 flex-wrap text-xs opacity-60">
                {t.project && (
                    <span class="badge badge-outline">📂 {t.project}</span>
                )}
                {t.created && (
                    <span class="badge badge-outline">
                        🕐 {new Date(t.created).toLocaleString()}
                    </span>
                )}
                {t.updated && t.updated !== t.created && (
                    <span class="badge badge-outline">
                        ✏️ {new Date(t.updated).toLocaleString()}
                    </span>
                )}
            </div>
            {t.detail && (
                <div>
                    <h3 class="text-xs font-semibold opacity-60 mb-1">详情</h3>
                    <div class="text-sm whitespace-pre-wrap">{t.detail}</div>
                </div>
            )}
            {t.body && (
                <div>
                    <h3 class="text-xs font-semibold opacity-60 mb-1">正文</h3>
                    <div class="text-sm whitespace-pre-wrap leading-relaxed">
                        {t.body}
                    </div>
                </div>
            )}
        </div>
    );
}
