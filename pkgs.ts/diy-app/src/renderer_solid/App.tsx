import { createSignal, onMount, onCleanup, Show } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { TaskTree } from "./components/TaskTree";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { LlmPage } from "./components/LlmPage";
import { LogPanel } from "./components/LogPanel";
import { AppInfo } from "./components/AppInfo";
import { ThemeSettings } from "./components/ThemeSettings";
import { ToastContainer } from "./components/ToastContainer";
import { taskStore } from "./store/taskStore";
import { notificationStore, type ToastType } from "./store/notificationStore";
import { setRendererActions, resetRendererActions } from "./lib/renderer-actions";

type NavPage = "task" | "chat" | "llm" | "settings";

export default function App() {
    const [currentPage, setCurrentPage] = createSignal<NavPage>("task");
    const [subPage, setSubPage] = createSignal("info");
    // 侧栏默认紧缩（w-12 纯图标 rail 省空间）；悬停或锁定才展开 w-56，选导航后即回缩
    const [pinned, setPinned] = createSignal(false);
    const [hovered, setHovered] = createSignal(false);
    const expanded = () => pinned() || hovered();

    onMount(() => {
        taskStore.loadTree();
        setRendererActions({
            navigate: (page) => setCurrentPage(page as NavPage),
            focus: (uri) => taskStore.selectTask(uri),
            toast: (msg, level) => notificationStore.addToast(level ?? "info", msg),
        });
    });
    onCleanup(() => resetRendererActions());

    const navItems: Array<{ id: NavPage; label: string; icon: string }> = [
        { id: "task", label: "任务树", icon: "🌳" },
        { id: "llm", label: "LLM", icon: "🧠" },
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
                        // 只在任务树页面生效：其他页面（Agent/LLM/设置）点击不应取消选中任务，
                        // 否则 Agent 面板里点输入框/发送按钮都会把 selectedUri 清掉 → 发不出消息
                        if (currentPage() === "task" && taskStore.selectedUri) taskStore.selectTask(null);
                    }}
                >
                    <Show when={currentPage() === "task"}>
                        <TaskTree />
                    </Show>
                    <Show when={currentPage() === "llm"}>
                        <LlmPage />
                    </Show>
                    <Show when={currentPage() === "settings"}>
                        <div class="flex flex-col h-full">
                            <div class="border-b px-3 py-2 shrink-0">
                                <Tabs.Root value={subPage()} onChange={setSubPage}>
                                    <Tabs.List class="tabs tabs-box">
                                        <Tabs.Trigger value="info" class="tab">
                                            📊 状态
                                        </Tabs.Trigger>
                                        <Tabs.Trigger value="logs" class="tab">
                                            📋 日志
                                        </Tabs.Trigger>
                                        <Tabs.Trigger value="theme" class="tab">
                                            🎨 外观
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
                            <Show when={subPage() === "theme"}>
                                <ThemeSettings />
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
                {/* 宽用内联 style：daisyUI .menu{width:fit-content} 是非分层样式，会压住 w-12/w-56 utility
                    收起态同步去掉 menu 的 8px 水平 padding（p-0），否则按钮内容超出 rail 被顶到右侧 */}
                <div
                    class={`menu bg-base-200 min-h-full transition-all duration-200 whitespace-nowrap overflow-hidden ${expanded() ? "p-2" : "p-0"}`}
                    style={{ width: expanded() ? "14rem" : "2.5rem" }}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                >
                    <div class="border-b font-bold h-12 flex items-center justify-center">
                        <span title="diy">◉</span>
                    </div>
                    <div class={`space-y-1 ${expanded() ? "p-1" : "py-2"}`}>
                        {navItems.map((item) => (
                            <li class="flex justify-center">
                                {/* tab 式选中指示：当前页加高亮胶囊 + 左侧指示条，收起态也可见 */}
                                <button
                                    class={`flex items-center gap-2 w-full transition-colors cursor-pointer ${expanded() ? "px-3 py-2 rounded-lg" : "h-8 w-8 rounded-lg justify-center"} ${currentPage() === item.id ? "bg-primary/30 text-base-content font-semibold ring-1 ring-primary/40" : "hover:bg-base-300"}`}
                                    title={item.label}
                                    onClick={() => {
                                        setCurrentPage(item.id);
                                        setHovered(false);
                                    }}
                                >
                                    <span>{item.icon}</span>
                                    {expanded() && <span>{item.label}</span>}
                                </button>
                            </li>
                        ))}
                    </div>
                    <div class="p-1 border-t mt-auto">
                        <button
                            class="w-full flex justify-center opacity-60 hover:opacity-100"
                            title={pinned() ? "取消锁定（恢复悬停展开）" : "锁定展开"}
                            onClick={() => setPinned(!pinned())}
                        >
                            <span>{pinned() ? "📌" : "📍"}</span>
                        </button>
                    </div>
                </div>
            </div>

            <ToastContainer />
        </div>
    );
}
