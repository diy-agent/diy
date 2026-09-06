import { onMount, onCleanup, Show } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { taskStore, type TaskDetail } from "../store/taskStore";
import { ChatPage } from "./ChatPage";

export function TaskDetailPanel() {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") taskStore.selectTask(null);
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));

    return (
        <Show when={!!taskStore.selectedUri}>
            <div
                class="card bg-base-100 border-l shadow-xl absolute inset-y-0 right-0 z-40 h-full flex flex-col"
                style="width:65%"
                onClick={(e) => e.stopPropagation()}
            >
                {/* 卡片头部：URI + 关闭 */}
                <div class="flex items-center justify-between px-4 py-2 border-b shrink-0">
                    <span class="text-xs font-mono opacity-60 truncate max-w-[300px]">
                        {taskStore.selectedUri}
                    </span>
                    <button class="btn btn-ghost btn-sm" onClick={() => taskStore.selectTask(null)}>
                        ✕
                    </button>
                </div>

                {/* Tab 切换：Agent 对话（默认）/ 任务详情 */}
                <Tabs.Root defaultValue="agent" class="flex flex-col flex-1 overflow-hidden">
                    <Tabs.List class="tabs tabs-bordered tabs-sm px-4 shrink-0">
                        <Tabs.Trigger value="agent" class="tab">🤖 Agent</Tabs.Trigger>
                        <Tabs.Trigger value="info" class="tab">📋 详情</Tabs.Trigger>
                    </Tabs.List>

                    {/* Agent 对话 —— 完整聊天页（任务由面板选中驱动，进入即建会话开聊） */}
                    <Tabs.Content value="agent" class="flex-1 overflow-hidden">
                        <ChatPage />
                    </Tabs.Content>

                    {/* 任务详情 —— 元信息 */}
                    <Tabs.Content value="info" class="flex-1 overflow-auto p-4">
                        <Show when={taskStore.selectedTask} fallback={<div class="opacity-60 text-sm">加载中…</div>}>
                            {(t) => <TaskInfoView task={t()} />}
                        </Show>
                    </Tabs.Content>
                </Tabs.Root>
            </div>
        </Show>
    );
}

function TaskInfoView(props: { task: TaskDetail }) {
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
                    <span class="badge badge-outline">📂 {t.project_label ?? t.project_path ?? t.project}</span>
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
