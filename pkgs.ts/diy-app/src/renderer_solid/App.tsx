// @ts-nocheck
import { createSignal, onMount, onCleanup, Show } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { TaskTree } from "./components/TaskTree";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { AgentChatPanel } from "./components/AgentChatPanel";
import { LlmPage } from "./components/LlmPage";
import { LogPanel } from "./components/LogPanel";
import { AppInfo } from "./components/AppInfo";
import { ToastContainer } from "./components/ToastContainer";
import { taskStore } from "./store/taskStore";
import { notificationStore } from "./store/notificationStore";
import { setRendererActions, resetRendererActions } from "./lib/renderer-actions";

type NavPage = "task" | "llm" | "agent" | "settings";

export default function App() {
    const [currentPage, setCurrentPage] = createSignal<NavPage>("task");
    const [subPage, setSubPage] = createSignal("info");
    const [collapsed, setCollapsed] = createSignal(false);

    onMount(() => {
        taskStore.loadTree();
        setRendererActions({
            navigate: (page) => setCurrentPage(page as NavPage),
            focus: (uri) => taskStore.selectTask(uri),
            toast: (msg, level) => notificationStore.addToast(level as any, msg),
        });
    });
    onCleanup(() => resetRendererActions());

    const navItems: Array<{ id: NavPage; label: string; icon: string }> = [
        { id: "task", label: "任务树", icon: "🌳" },
        { id: "llm", label: "LLM", icon: "🧠" },
        { id: "agent", label: "Agent", icon: "🤖" },
        { id: "settings", label: "设置", icon: "⚙️" },
    ];

    return (
        <div class="drawer lg:drawer-open">
            {/* DaisyUI drawer 必须的 checkbox（控制开合，:checked 决定侧栏是否展开） */}
            <input type="checkbox" id="sidebar-toggle" class="drawer-toggle" />
            {/* 主内容区 */}
            <div class="drawer-content flex flex-col h-screen">
                {/* 顶栏 */}
                <div class="navbar bg-base-100 border-b shrink-0 h-12">
                    <span class="text-sm font-bold">diy</span>
                </div>

                {/* 内容区 */}
                <main
                    class="flex-1 relative overflow-hidden bg-base-100"
                    onClick={() => {
                        // 点击空白处关闭任务详情面板（任务行/面板自身已 stopPropagation 接管）
                        if (taskStore.selectedUri) taskStore.selectTask(null);
                    }}
                >
                    <Show when={currentPage() === "task"}>
                        <TaskTree />
                    </Show>
                    <Show when={currentPage() === "llm"}>
                        <LlmPage />
                    </Show>
                    <Show when={currentPage() === "agent"}>
                        <AgentChatPanel />
                    </Show>
                    <Show when={currentPage() === "settings"}>
                        <div class="flex flex-col h-full">
                            <div class="border-b px-3 py-2 shrink-0">
                                <Tabs.Root value={subPage()} onValueChange={setSubPage}>
                                    <Tabs.List class="tabs tabs-box">
                                        <Tabs.Trigger value="info" class="tab">
                                            📊 状态
                                        </Tabs.Trigger>
                                        <Tabs.Trigger value="logs" class="tab">
                                            📋 日志
                                        </Tabs.Trigger>
                                    </Tabs.List>
                                </Tabs.Root>
                            </div>
                            <Show when={subPage() === "info"}>
                                <AppInfo />
                            </Show>
                            <Show when={subPage() === "logs"}>
                                <LogPanel />
                            </Show>
                        </div>
                    </Show>
                    <Show when={currentPage() === "task"}>
                        <TaskDetailPanel />
                    </Show>
                </main>

                {/* 底栏 */}
                <div class="footer bg-base-200 border-t text-xs opacity-60 h-7 px-3 shrink-0">
                    <span>diy 管控台</span>
                    <Show when={!!taskStore.selectedUri}>
                        <span class="ml-2 truncate">{taskStore.selectedUri}</span>
                    </Show>
                </div>
            </div>

            {/* 侧栏 - DaisyUI drawer */}
            <div class="drawer-side z-40">
                <label for="sidebar-toggle" class="drawer-overlay" />
                <div
                    class={`menu bg-base-200 min-h-full transition-all duration-200 ${collapsed() ? "w-14" : "w-56"}`}
                >
                    <div class="p-2 border-b font-bold h-12 flex items-center gap-2">
                        <span>◉</span>
                        {!collapsed() && <span>diy</span>}
                    </div>
                    <div class="p-2 space-y-1">
                        {!collapsed() && (
                            <div class="text-xs opacity-60 px-2 py-1">导航</div>
                        )}
                        {navItems.map((item) => (
                            <li class={collapsed() ? "flex justify-center" : ""}>
                                <button
                                    class={currentPage() === item.id ? "active" : ""}
                                    title={item.label}
                                    onClick={() => setCurrentPage(item.id)}
                                >
                                    <span>{item.icon}</span>
                                    {!collapsed() && <span>{item.label}</span>}
                                </button>
                            </li>
                        ))}
                    </div>
                    <div class="p-2 border-t">
                        <button
                            class="w-full flex justify-center"
                            title={collapsed() ? "展开" : "收起"}
                            onClick={() => setCollapsed(!collapsed())}
                        >
                            <span>{collapsed() ? "›" : "‹ 收起"}</span>
                        </button>
                    </div>
                </div>
            </div>

            <ToastContainer />
        </div>
    );
}
