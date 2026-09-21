import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { TaskTree } from "./components/TaskTree";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskRunPage } from "./components/TaskRunPage";
import { LlmPage } from "./components/LlmPage";
// 折叠框展开态仍是 lab view 内部的局部状态（与「view 在哪个 area」是两件事）
import { setLabView } from "./components/PromptLabV4Page";
import { AppInfo } from "./components/AppInfo";
import { LogPanel } from "./components/LogPanel";
import { ThemeSettings } from "./components/ThemeSettings";
import { ToastContainer } from "./components/ToastContainer";
import { taskStore, type TreeNode } from "./store/taskStore";
import { tabStore } from "./store/tabStore";
import { layoutStore } from "./store/layoutStore";
import { diyService } from "./lib/rpc";
import { notificationStore } from "./store/notificationStore";
import { setRendererActions, resetRendererActions } from "./lib/renderer-actions";

/**
 * 路由（page 一级 + 任务执行页的实例）。
 *
 * 「任务执行页」不在顶级导航里 —— 它是**动态页面**：每打开一个任务就多一个，
 * 挂在导航「任务」之下（等同浏览器/编辑器开 tab）。故用 route 而不是扁平 page id。
 */
type Route =
    | { page: "task" }
    | { page: "task-run"; uri: string }
    | { page: "llm" }
    | { page: "settings" };

/** 顶级导航（一侧栏项 = 一类事情）。任务执行页不出现在这里，它是任务下的动态页面 */
const NAV_ITEMS: Array<{ id: "task" | "llm" | "settings"; label: string; icon: string }> = [
    { id: "task", label: "任务管理", icon: "📋" },
    { id: "llm", label: "LLM", icon: "🧠" },
    { id: "settings", label: "设置", icon: "⚙️" },
];

/** `ui page navigate` 的合法取值（非法值一律忽略：宁可不跳，也不能把主区打成白屏） */
const VALID_PAGES = new Set(["task", "task-run", "llm", "settings"]);

/** 从任务树里找节点（tab 标题用） */
function findNode(nodes: TreeNode[], uri: string): TreeNode | undefined {
    for (const n of nodes) {
        if (n.uri === uri) return n;
        const hit = findNode(n.children ?? [], uri);
        if (hit) return hit;
    }
    return undefined;
}

export default function App() {
    // 启动时恢复上次的 tab（视图 cache；丢了只是回到任务树）
    const [route, setRoute] = createSignal<Route>(
        tabStore.active ? { page: "task-run", uri: tabStore.active } : { page: "task" },
    );
    const [subPage, setSubPage] = createSignal("info");
    // 侧栏默认紧缩（w-12 纯图标 rail 省空间）；悬停或锁定才展开 w-56，选导航后即回缩
    const [pinned, setPinned] = createSignal(false);
    const [hovered, setHovered] = createSignal(false);
    const expanded = () => pinned() || hovered();

    /**
     * 侧栏高亮：**同一时刻只有一处**。
     * 任务执行页时不高亮「任务管理」—— 高亮交给具体任务 tab（否则会同时亮两个，
     * 让人分不清「当前在哪」）。
     */
    const navActive = (): string | null => {
        const r = route();
        return r.page === "task-run" ? null : r.page;
    };

    /** 当前激活的任务 tab（无则 null） */
    const activeTab = () => {
        const r = route();
        return r.page === "task-run" ? r.uri : null;
    };

    /** tab 的状态圆点色 */
    const tabDot = (uri: string) => {
        const st = findNode(taskStore.nodes, uri)?.state;
        return st === "done" ? "bg-success" : st === "blocked" ? "bg-error" : "bg-info";
    };

    /** tab 标题：优先任务标题，退化到 URI 末段 */
    const tabLabel = (uri: string) => {
        const n = findNode(taskStore.nodes, uri);
        return n?.num ? `#${n.num} ${n.title ?? uri}` : (n?.title ?? uri);
    };

    let fsAbort: AbortController | undefined;

    onMount(() => {
        taskStore.loadTree();
        setRendererActions({
            navigate: (page) => {
                if (!VALID_PAGES.has(page)) return; // 非法值忽略，保持当前视图
                if (page === "task-run") {
                    const a = tabStore.active;
                    setRoute(a ? { page: "task-run", uri: a } : { page: "task" });
                    return;
                }
                if (page === "task") tabStore.showTree();
                setRoute({ page } as Route);
            },
            focus: (uri) => taskStore.selectTask(uri),
            setView: (key, open) => setLabView(key, open),
            setViewArea: (area, open) => {
                // 阶段 1 只有任务执行页是多 area 的 page；area 开合即 hidden 取反
                layoutStore.setAreaHidden("task-run", area, !open);
            },
            openTaskRun: (uri) => {
                tabStore.open(uri);
                setRoute({ page: "task-run", uri });
            },
            activateTab: (uri) => {
                tabStore.activate(uri);
                setRoute({ page: "task-run", uri });
            },
            closeTab: (uri) => {
                tabStore.close(uri);
                const next = tabStore.active;
                setRoute(next ? { page: "task-run", uri: next } : { page: "task" });
            },
            toast: (msg, level) => notificationStore.addToast(level ?? "info", msg),
        });
        // main 进程 FileWatcher 检测到文件变更后推送 "task-change"，
        // renderer 订阅后自动刷新任务树，覆盖 CLI/外部编辑器/agent 建任务等所有路径。
        fsAbort = new AbortController();
        void diyService.diy.watch.fileChange({}, { signal: fsAbort.signal }).then(async (stream) => {
            for await (const change of stream) {
                if (change.event === "task-change") taskStore.loadTree();
            }
        });
    });
    onCleanup(() => {
        fsAbort?.abort();
        resetRendererActions();
    });

    const goSection = (id: "task" | "llm" | "settings") => {
        setHovered(false);
        if (id === "task") {
            tabStore.showTree();
            setRoute({ page: "task" });
            return;
        }
        setRoute({ page: id } as Route);
    };

    /** 关闭 tab：与任务状态无关（= 暂时不理会）。关掉当前 tab 则顺位切到邻近 tab，没有就回树 */
    const closeTab = (uri: string) => {
        tabStore.close(uri);
        const r = route();
        if (r.page === "task-run" && r.uri === uri) {
            const next = tabStore.active;
            setRoute(next ? { page: "task-run", uri: next } : { page: "task" });
        }
    };

    return (
        <div class="drawer lg:drawer-open">
            {/* DaisyUI drawer 必须的 checkbox（控制开合，:checked 决定侧栏是否展开） */}
            <input type="checkbox" id="sidebar-toggle" class="drawer-toggle" />
            {/* 主内容区 */}
            <div class="drawer-content flex flex-col h-screen">
                <main
                    class="flex-1 relative overflow-hidden bg-base-100"
                    onClick={() => {
                        // 点击空白处关闭任务详情面板（任务行/面板自身已 stopPropagation 接管）
                        // 只在任务树页面生效：其他页面点击不应取消选中任务
                        if (route().page === "task" && taskStore.selectedUri) taskStore.selectTask(null);
                    }}
                >
                    <Show when={route().page === "task"}>
                        <TaskTree />
                        <TaskDetailPanel />
                    </Show>
                    <Show when={route().page === "task-run"}>
                        {/* keyed：每个任务一个独立实例（切 tab 时组件重建，状态由 store 恢复） */}
                        <Show when={route()} keyed>
                            {(r) => <TaskRunPage uri={(r as { uri: string }).uri} />}
                        </Show>
                    </Show>
                    <Show when={route().page === "llm"}>
                        <LlmPage />
                    </Show>
                    <Show when={route().page === "settings"}>
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
                </main>
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
                        <For each={NAV_ITEMS}>
                            {(item) => (
                                <>
                                    <li class="flex justify-center">
                                        {/* tab 式选中指示：当前页加高亮胶囊 + 左侧指示条，收起态也可见 */}
                                        <button
                                            class={`flex items-center gap-2 w-full transition-colors cursor-pointer ${expanded() ? "px-3 py-2 rounded-lg" : "h-8 w-8 rounded-lg justify-center"} ${navActive() === item.id ? "bg-primary/30 text-base-content font-semibold ring-1 ring-primary/40" : "hover:bg-base-300"}`}
                                            title={item.label}
                                            onClick={() => goSection(item.id)}
                                        >
                                            <span>{item.icon}</span>
                                            {expanded() && <span>{item.label}</span>}
                                        </button>
                                    </li>
                                    {/* 「任务管理」下的动态页面：每个打开的任务一项（等同编辑器开 tab）。
                                        **展开与收缩两态结构一致** —— 收缩态用「序号」图标承载同样的
                                        层级与选中语义（收缩态不显示标题与关闭按钮，装不下）。 */}
                                    <Show when={item.id === "task"}>
                                        <For each={tabStore.opened}>
                                            {(uri) => {
                                                const isActive = () => activeTab() === uri;
                                                const num = () => findNode(taskStore.nodes, uri)?.num;
                                                return (
                                                    <li class="flex justify-center">
                                                        <Show
                                                            when={expanded()}
                                                            fallback={
                                                                <button
                                                                    class={`relative flex items-center justify-center h-7 w-7 rounded-lg text-[10px] font-mono transition-colors cursor-pointer ${
                                                                        isActive()
                                                                            ? "bg-primary/30 ring-1 ring-primary/40 font-semibold"
                                                                            : "hover:bg-base-300 opacity-70"
                                                                    }`}
                                                                    title={tabLabel(uri)}
                                                                    onClick={() => {
                                                                        tabStore.activate(uri);
                                                                        setRoute({ page: "task-run", uri });
                                                                    }}
                                                                >
                                                                    <span class={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${tabDot(uri)}`} />
                                                                    {num() ?? "•"}
                                                                </button>
                                                            }
                                                        >
                                                            <div
                                                                class={`group flex items-center gap-1 w-full pl-7 pr-1 py-1 rounded-lg text-xs cursor-pointer transition-colors ${
                                                                    isActive() ? "bg-primary/25 ring-1 ring-primary/30" : "hover:bg-base-300"
                                                                }`}
                                                                title={uri}
                                                                onClick={() => {
                                                                    tabStore.activate(uri);
                                                                    setRoute({ page: "task-run", uri });
                                                                }}
                                                            >
                                                                <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${tabDot(uri)}`} />
                                                                <span class="truncate flex-1">{tabLabel(uri)}</span>
                                                                {/* 关闭 = 暂时不理会该任务，与任务状态无关 */}
                                                                <button
                                                                    class="btn btn-ghost btn-xs px-1 opacity-0 group-hover:opacity-70 hover:!opacity-100 shrink-0"
                                                                    title="关闭（暂时不理会，不影响任务状态）"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        closeTab(uri);
                                                                    }}
                                                                >
                                                                    ✕
                                                                </button>
                                                            </div>
                                                        </Show>
                                                    </li>
                                                );
                                            }}
                                        </For>
                                    </Show>
                                </>
                            )}
                        </For>
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
