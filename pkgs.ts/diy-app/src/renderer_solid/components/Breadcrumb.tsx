/**
 * Breadcrumb — page 级面包屑导航栏。
 *
 * 位置：主区顶部，所有页面均显示。
 * 语义：从当前页面回溯到根，每个非叶子节点带 ▾ 下拉（列出同级 tab）。
 *
 * 规则（见 133「一页一中心」+ 面包屑草图）：
 *   - 点链接文字 → 切到对应页面/section
 *   - 点 ▾ → 弹出下拉菜单，列出该层级下所有已打开的 tab
 *   - 下拉菜单中当前 tab 加 ◀ 标记，hover 显示 ✕ 可关闭
 *   - 顶级 section（无 tab 上下文）显示自身名称，无 ▾
 *   - lab 是叶子（无 ▾），task-run 的 ▾ = 其 lab 子页面
 */
import { Show, For, createSignal, onCleanup, onMount } from "solid-js";
import { findPage } from "../../shared/view-registry";
import { taskStateColor } from "../../main/core/task-state";
import { tabStore, type TabItem } from "../store/tabStore";
import { taskStore, type TreeNode } from "../store/taskStore";

// ═══════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════

function findNode(nodes: TreeNode[], uri: string): TreeNode | undefined {
    for (const n of nodes) {
        if (n.uri === uri) return n;
        const hit = findNode(n.children ?? [], uri);
        if (hit) return hit;
    }
    return undefined;
}

function tabLabel(uri: string): string {
    const n = findNode(taskStore.nodes, uri);
    return n?.num ? `#${n.num} ${n.title ?? uri}` : (n?.title ?? uri);
}


const SECTIONS: Record<string, { label: string; icon: string }> = {
    task: { label: "任务管理", icon: "📋" },
    llm: { label: "LLM", icon: "🧠" },
    settings: { label: "设置", icon: "⚙️" },
};

// ═══════════════════════════════════════
//  面包屑路径计算
// ═══════════════════════════════════════

/** 面包屑点击动作（computeCrumbs 保持纯函数，落到哪个函数由组件按 props 决定） */
type CrumbAction = { kind: "section"; id: string } | { kind: "tab"; key: string } | { kind: "none" };

interface Crumb {
    label: string;
    icon?: string;
    /** 点击去哪。`none` = 当前页（渲染成 disabled，不该是「能点但没反应」） */
    action: CrumbAction;
    /** ▾ 下拉的同级 tab 列表（null = 无下拉） */
    siblings: TabItem[] | null;
    isCurrent: boolean;
}

function computeCrumbs(activeKey: string, section: string): Crumb[] {
    // ── section 路由（无 tab 上下文） ──
    if (!activeKey) {
        const info = SECTIONS[section] ?? { label: section, icon: "📄" };
        return [{
            label: info.label,
            icon: info.icon,
            action: { kind: "none" }, // 已在当前 section
            siblings: null,
            isCurrent: true,
        }];
    }

    // ── tab 路由 ──
    const tab = tabStore.find(activeKey);
    if (!tab) return [];

    // 收集祖先链（从根到父）
    const ancestors: TabItem[] = [];
    let cur: TabItem | undefined = tab;
    while (cur) {
        const def = findPage(cur.pageId);
        if (!def?.parentPage) break;
        const parentKey = cur.parent ?? `${def.parentPage}:${cur.ctx}`;
        const parentTab = tabStore.find(parentKey);
        if (!parentTab) break;
        ancestors.unshift(parentTab);
        cur = parentTab;
    }

    const crumbs: Crumb[] = [];

    // ① 顶级 section（面包屑根）
    const secInfo = SECTIONS[section] ?? { label: section, icon: "📄" };
    const taskRunTabs = tabStore.opened.filter((t) => t.pageId === "task-run");
    crumbs.push({
        label: secInfo.label,
        icon: secInfo.icon,
        action: { kind: "section", id: section },
        siblings: taskRunTabs.length > 0 ? taskRunTabs : null,
        isCurrent: false,
    });

    // ② 祖先（每个非叶子）
    for (const anc of ancestors) {
        const def = findPage(anc.pageId);
        const label = anc.pageId === "task-run" ? tabLabel(anc.ctx ?? "") : (def?.title ?? anc.pageId);
        const siblings = tabStore.opened.filter((t) => {
            if (t.pageId !== anc.pageId) return false;
            if (anc.pageId !== "task-run" && anc.ctx && t.ctx !== anc.ctx) return false;
            return true;
        });
        crumbs.push({
            label,
            action: { kind: "tab", key: anc.key },
            siblings: siblings.length > 1 ? siblings : null,
            isCurrent: false,
        });
    }

    // ③ 当前页（叶子，无下拉）
    {
        const def = findPage(tab.pageId);
        const label = tab.pageId === "task-run" ? tabLabel(tab.ctx ?? "") : (def?.title ?? tab.pageId);
        crumbs.push({
            label,
            action: { kind: "none" }, // 当前页：下面按 isCurrent 渲染成 disabled
            siblings: null,
            isCurrent: true,
        });
    }

    return crumbs;
}

// ═══════════════════════════════════════
//  下拉菜单组件
// ═══════════════════════════════════════

function CrumbDropdown(props: {
    items: TabItem[];
    currentKey: string;
    onSelect: (key: string) => void;
    onClose: (key: string) => void;
}) {
    const [open, setOpen] = createSignal(false);
    let btnRef: HTMLButtonElement | undefined;
    let menuRef: HTMLUListElement | undefined;

    const dismiss = () => setOpen(false);

    const onDocClick = (e: MouseEvent) => {
        if (!menuRef?.contains(e.target as Node) && !btnRef?.contains(e.target as Node)) {
            dismiss();
        }
    };

    // open/close 时注册/移除全局监听
    const watchOpen = () => {
        if (open()) document.addEventListener("mousedown", onDocClick);
        else document.removeEventListener("mousedown", onDocClick);
    };
    onMount(watchOpen);
    onCleanup(() => document.removeEventListener("mousedown", onDocClick));

    const labelOf = (t: TabItem): string => {
        if (t.pageId === "lab") {
            const num = t.ctx ? findNode(taskStore.nodes, t.ctx)?.num : undefined;
            return `提示词${num ? ` #${num}` : ""}`;
        }
        return tabLabel(t.ctx ?? "");
    };

    return (
        <div class="dropdown dropdown-bottom">
            <button
                ref={btnRef}
                tabindex={0}
                class="btn btn-ghost btn-xs px-0.5 min-h-0 h-4 text-[10px] leading-none opacity-40 hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); setOpen(!open()); watchOpen(); }}
            >
                ▾
            </button>
            <Show when={open()}>
                <ul
                    ref={menuRef}
                    tabindex={0}
                    class="dropdown-content menu p-1 shadow-lg bg-base-200 rounded-box w-52 text-xs z-50 max-h-60 overflow-y-auto"
                    onClick={dismiss}
                >
                    <For each={props.items}>
                        {(t) => {
                            const isCur = t.key === props.currentKey;
                            return (
                                <li>
                                    <div
                                        class={`flex items-center gap-2 cursor-pointer min-h-0 py-1.5 ${isCur ? "font-semibold bg-primary/15" : "hover:bg-base-300"}`}
                                        onClick={() => props.onSelect(t.key)}
                                    >
                                        <Show
                                            when={t.pageId === "task-run"}
                                            fallback={<span class="w-1.5 shrink-0 opacity-40">↳</span>}
                                        >
                                            <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${taskStateColor(findNode(taskStore.nodes, t.ctx ?? "")?.state)}`} />
                                        </Show>
                                        <span class="flex-1 truncate">{labelOf(t)}</span>
                                        {isCur && <span class="text-primary text-[10px]">◀</span>}
                                        <button
                                            class="btn btn-ghost btn-xs px-0.5 min-h-0 h-4 opacity-0 hover:!opacity-100 text-[10px]"
                                            title="关闭"
                                            onClick={(e) => { e.stopPropagation(); props.onClose(t.key); }}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </li>
                            );
                        }}
                    </For>
                </ul>
            </Show>
        </div>
    );
}

// ═══════════════════════════════════════
//  主组件
// ═══════════════════════════════════════

export interface BreadcrumbProps {
    /** 当前 section id */
    section: string;
    /** 当前 tab key（"" = 在 section 页面） */
    activeKey: string;
    /** 通用路由跳转 */
    gotoTab: (key: string) => void;
    gotoSection: (id: string) => void;
    closeTab: (key: string) => void;
}

export function Breadcrumb(props: BreadcrumbProps) {
    const crumbs = () => computeCrumbs(props.activeKey, props.section);

    /**
     * 派发面包屑点击。
     *
     * ⚠️ 这里曾经是 `crumb.onClick()`，而 computeCrumbs 里三个分支都写成
     * `onClick: () => {}`（注释「App 侧会处理」）—— 实际没人处理，于是
     * 「点面包屑切父页面」在界面上是**点了没反应**（真实点击测试抓到的）。
     * 现在 action 是显式数据，落到 props 的哪个回调由本函数决定。
     */
    const handleClick = (crumb: Crumb, tab?: TabItem) => {
        if (tab) {
            props.gotoTab(tab.key);
            return;
        }
        const a = crumb.action;
        if (a.kind === "section") props.gotoSection(a.id);
        else if (a.kind === "tab") props.gotoTab(a.key);
        // kind === "none"：当前页，按钮已 disabled，走不到这里
    };

    return (
        <nav class="flex items-center gap-0.5 px-3 py-1 text-[13px] border-b border-base-300/60 bg-base-200/30 shrink-0 select-none min-h-[2rem]">
            <For each={crumbs()}>
                {(crumb, i) => (
                    <span class="flex items-center gap-0.5 shrink-0">
                        {i() > 0 && <span class="text-base-content/25 mx-1 text-[11px]">›</span>}
                        <button
                            class={`btn btn-ghost btn-xs px-1.5 min-h-0 h-5 normal-case font-normal whitespace-nowrap ${
                                crumb.isCurrent
                                    ? "text-base-content font-semibold cursor-default"
                                    : "text-base-content/70 hover:text-primary"
                            }`}
                            onClick={() => handleClick(crumb)}
                            disabled={crumb.isCurrent}
                        >
                            {crumb.icon && <span class="text-[12px]">{crumb.icon}</span>}
                            {crumb.label}
                        </button>
                        <Show when={crumb.siblings && crumb.siblings.length > 0}>
                            <CrumbDropdown
                                items={crumb.siblings!}
                                currentKey={props.activeKey}
                                onSelect={(key) => props.gotoTab(key)}
                                onClose={props.closeTab}
                            />
                        </Show>
                    </span>
                )}
            </For>
        </nav>
    );
}
