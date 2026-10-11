import { createSignal, createEffect, on, onMount, onCleanup, untrack, Show, For } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { TaskTree } from "./components/TaskTree";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskRunPage } from "./components/TaskRunPage";
import { LabPage } from "./components/LabPage";
import { LlmPage } from "./components/LlmPage";
import { ModelConfigPage } from "./components/ModelConfigPage";
// 折叠框展开态仍是 lab view 内部的局部状态（与「view 在哪个 area」是两件事）
import { setLabView } from "./components/PromptLabV4Page";
import { ContextLabPage, setCtxLabFold } from "./components/ContextLabPage";
import { AppInfo } from "./components/AppInfo";
import { LogPanel } from "./components/LogPanel";
import { ThemeSettings } from "./components/ThemeSettings";
import { ToastContainer } from "./components/ToastContainer";
import { taskStore, type TreeNode } from "./store/taskStore";
import { tabStore } from "./store/tabStore";
import { layoutStore } from "./store/layoutStore";
import { diyService } from "./lib/rpc";
import { notificationStore } from "./store/notificationStore";
import { defaultBinding, findPage, findView, viewInstanceKey } from "../shared/view-registry";
import { taskIndentOf } from "../shared/tab-order";
import { taskStateColor } from "../main/core/task-state";
import { instanceTitle } from "../shared/instance-title";
import { Caches, NAV_W_MIN, NAV_W_MAX, NAV_W_DEFAULT } from "./lib/ui-state";
import { VIEW_BAR_H } from "./lib/layout-metrics";
import { TaskSideView } from "./components/TaskSideView";
import { Breadcrumb } from "./components/Breadcrumb";
import { NavSearch } from "./components/NavSearch";
import { FindBar } from "./components/FindBar";
import { findStore } from "./store/findStore";
import { setRendererActions, resetRendererActions, getRendererActions } from "./lib/renderer-actions";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable, PointerSensor } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { findTaskProject } from "./components/TaskTree";
import { isAncestorOf } from "./lib/task-lineage";

/**
 * 路由（page 一级 + 任务执行页的实例）。
 *
 * 「任务执行页」不在顶级导航里 —— 它是**动态页面**：每打开一个任务就多一个，
 * 挂在导航「任务」之下（等同浏览器/编辑器开 tab）。故用 route 而不是扁平 page id。
 */
type Section = "task" | "llm" | "settings";

/**
 * 路由 = 顶级 section，或一个**已打开的 tab**（key 形如 `task-run:<uri>` / `lab:<uri>`）。
 * 任务执行页与提示词页都是 tab —— 后者是前者的子页面（见 133「一页一中心」）。
 */
type Route = { kind: "section"; section: Section } | { kind: "tab"; key: string };

// dnd-kit/solid 未直接导出 DragEndEvent，从 onDragEnd 回调参数提取（TaskTree 同款）
type DragEndEvent = Parameters<NonNullable<DragDropProviderProps["onDragEnd"]>>[0];

/** 顶级导航（一侧栏项 = 一类事情）。任务执行页不出现在这里，它是任务下的动态页面 */
const NAV_ITEMS: Array<{ id: "task" | "llm" | "settings"; label: string; icon: string }> = [
    { id: "task", label: "任务管理", icon: "📋" },
    { id: "llm", label: "LLM", icon: "🧠" },
    { id: "settings", label: "设置", icon: "⚙️" },
];

/** `ui page navigate` 的合法取值（非法值一律忽略：宁可不跳，也不能把主区打成白屏） */
const VALID_PAGES = new Set(["task", "task-run", "lab", "llm", "settings"]);

/** 从任务树里找节点（tab 标题用） */
function findNode(nodes: TreeNode[], uri: string): TreeNode | undefined {
    for (const n of nodes) {
        if (n.uri === uri) return n;
        const hit = findNode(n.children ?? [], uri);
        if (hit) return hit;
    }
    return undefined;
}

/**
 * 某任务 URI 的祖先链（不含自己，从根到直接父）。
 *
 * 任务树才是父子关系的真相源 —— URI 路径（`projects/<pid>/tasks/<n>`）**不表达**
 * 层级（a/b/c 是 parentUri 关系，不是路径关系），故必须查树。
 * 结果存进 tab：持久化后仍能用于排序与缩进，不必每次重算。
 */
function taskAncestorsOf(uri: string | null): string[] | undefined {
    if (!uri) return undefined;
    const chain: string[] = [];
    let cur = findNode(taskStore.nodes, uri)?.parentUri;
    const seen = new Set<string>([uri]); // 防环（脏数据不该把这里转死）
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        chain.unshift(cur);
        cur = findNode(taskStore.nodes, cur)?.parentUri;
    }
    return chain.length > 0 ? chain : undefined;
}

export default function App() {
    // 启动时恢复上次的 tab（视图 cache；丢了只是回到任务树）
    const [route, setRoute] = createSignal<Route>(
        tabStore.active ? { kind: "tab", key: tabStore.active } : { kind: "section", section: "task" },
    );
    const [subPage, setSubPage] = createSignal("info");
    // 侧栏默认紧缩（2.5rem 纯图标 rail 省空间）；悬停或锁定才展开，选导航后即回缩
    const [pinned, setPinned] = createSignal(false);
    const [hovered, setHovered] = createSignal(false);
    // 展开宽度（px）：右缘可拖，落视图 cache（见 ui-state 的 diy_nav_width）
    const [navW, setNavW] = createSignal(Caches.diy_nav_width.get());
    // 拖拽中的标记：期间**必须强制展开**，否则鼠标一离开侧栏就 mouseleave 收拢，
    // 宽度在「收拢 → 变宽 → 又展开」之间抖（见 onNavGripDown）
    const [resizingNav, setResizingNav] = createSignal(false);
    // nav 拖拽改父子（任务 242 / ##87）：拖拽期间屏蔽 hover 详情层（否则幽灵经过别的项
    // 就弹层，界面乱），松手即恢复
    const [navDragging, setNavDragging] = createSignal(false);
    const [navDragLabel, setNavDragLabel] = createSignal("");
    let navEl: HTMLDivElement | undefined;

    /**
     * nav 任务项拖拽 → 改父子（**只在 nav 项之间拖**，不跨 view/page —— 用户 2026-10-03 澄清）。
     * 语义与任务管理树一致（TaskTree handleDragEnd 同款）：拖到某任务上 = 成为其子任务；
     * dnd id 用 tab key（同一任务可开 task-run/ctxlab 多个 tab，uri 会撞），落点换算回任务 uri。
     */
    const handleNavDragEnd = async (event: DragEndEvent) => {
        if (event.operation?.canceled) return;
        const dragKey = String(event.operation?.source?.id ?? "");
        const dropKey = String(event.operation?.target?.id ?? "");
        if (!dragKey || !dropKey || dragKey === dropKey) return;
        const dragTab = tabStore.opened.find((t) => t.key === dragKey);
        const dropTab = tabStore.opened.find((t) => t.key === dropKey);
        const dragUri = dragTab?.ctx;
        const dropUri = dropTab?.ctx;
        if (!dragUri || !dropUri || dragUri === dropUri) return; // 同任务多 tab：互拖无意义
        const dragInfo = findTaskProject(taskStore.nodes, dragUri);
        const dropInfo = findTaskProject(taskStore.nodes, dropUri);
        if (!dragInfo || !dropInfo) return;
        if (dragInfo.project !== dropInfo.project) {
            notificationStore.addToast("error", "只能在同一项目内拖动");
            return;
        }
        // RV-07：防环预检 —— 拖到自己的子孙下成环。main 有守卫（数据安全无虞），
        // 客户端提前拦只为体验：非法落点当场报，不等 main 抛错。
        if (isAncestorOf(taskStore.nodes, dragUri, dropUri)) {
            notificationStore.addToast("error", "不能拖到自己的子任务下");
            return;
        }
        if (dropUri === dragInfo.parent) return; // 拖到直接父级：无需改动
        try {
            await diyService.diy.task.move({ uri: dragUri, parent: dropUri });
            await taskStore.loadTree(); // 树变 → tabStore 祖先链重算 → nav 缩进/顺序自动跟上（##159 链路）
            notificationStore.addToast("success", "已调整层级");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToast("error", `调整失败: ${msg}`);
        }
    };
    let mainAreaEl: HTMLDivElement | undefined;

    /**
     * 树刷新后清理「已从树里消失的任务」的 tab（226 关联：dropCtx 接线）。
     *
     * 删除任务（CLI `task delete` / 删目录）走 watch → loadTree，但摘 tab 的
     * `tabStore.dropCtx` 曾是零调用的死代码 —— 导航残留幽灵 tab（label 退化成 URI、
     * 点开是空白页）。diff 只认「上一轮在、这一轮不在」：首轮 prev 为空，启动时树
     * 未加载完（nodes=[]）不会把恢复出来的 tab 清光。树响应的乱序由 taskStore.loadTree
     * 的过期丢弃守住，防止旧快照让这里误判「任务消失」。
     */
    let prevUris = new Set<string>();
    // RV-03（##245 review）：切页后旧页面的查找 Range 随 Solid 卸载退化成 zeroWidth，
    // badge 还挂着过期计数（refresh 全仓零调用）。查找条是**页内**语义 → 换页即关
    // （close 会清 Range/计数/高亮，一步到位）。
    createEffect(on(() => route(), () => findStore.close()));
    createEffect(() => {
        const cur = new Set<string>();
        const walk = (ns: TreeNode[]) => {
            for (const n of ns) {
                if (n.uri) cur.add(n.uri); // 项目节点没有 uri，成不了 tab，跳过
                walk(n.children ?? []);
            }
        };
        walk(taskStore.nodes);
        const gone = [...prevUris].filter((u) => !cur.has(u));
        prevUris = cur;
        if (gone.length === 0) return;
        for (const u of gone) tabStore.dropCtx(u);
        // 被摘的恰是当前 route → route 悬空（主区所有 page 的 Show 全 false = 白屏）→ 跟随 active
        untrack(() => {
            const r = route();
            if (r.kind === "tab" && !tabStore.find(r.key)) {
                const k = tabStore.active;
                setRoute(k ? { kind: "tab", key: k } : { kind: "section", section: "task" });
            }
        });
    });

    /**
     * 切回「任务管理」页时，要求在树里**展开定位**到某个任务（##160）。
     *
     * 为什么需要外部下发而不是 TaskTree 自己推：树是「当前在哪」的索引，但切页那一刻
     * 路由已经离开 tab —— `tabStore.showTree()` 把 active 清空后，树无从知道
     * 「刚才是从哪个任务的会话回来的」。故由切页动作**在清空之前**把目标夺下来交给树。
     *
     * nonce 用于「重复点同一个导航项也要重新定位」：只比对 uri 的话，第二次点击
     * （比如用户在树里滚跑后想回到当前任务）不会触发任何变化。
     */
    const [treeReveal, setTreeReveal] = createSignal<{ uri: string; nonce: number } | null>(null);

    /** ⌘K 快速打开会话的弹层开关（##254）。内容与键盘导航见 components/NavSearch.tsx */
    const [navSearchOpen, setNavSearchOpen] = createSignal(false);

    /**
     * 记下「切页前的当前任务」并请求树定位它。
     *
     * 取值优先级：正在看的 tab 的任务（会话页/提示词页的 ctx）→ 树里选中的任务。
     * 两者都没有（首次进 app、纯任务管理操作）时什么都不做 —— 不定位总比乱定位好。
     * **必须在 `tabStore.showTree()` 之前调用**（active 清空后就取不到 ctx 了）。
     */
    const requestTreeReveal = (explicit?: string) => {
        const uri = explicit ?? tabStore.activeTab()?.ctx ?? taskStore.selectedUri;
        if (!uri) return;
        setTreeReveal({ uri, nonce: (treeReveal()?.nonce ?? 0) + 1 });
    };

    /**
     * 全局悬浮提示（viewport fixed）—— 取代 daisyUI 的 `tooltip`/`data-tip` 伪元素。
     *
     * 为什么统一收在这里：daisyUI 的 `.tooltip` 是元素上的 `::before` 伪元素，会被祖先的
     * `overflow-hidden/auto` 裁掉 —— 分区 area、详情抽屉、滚动容器里普遍踩到（用户反馈
     * 「任务详情 bar 的按钮提示被遮挡」即此）；原生 `title` 又有 OS 级延迟。
     * 改为 **document 级委托 + fixed 浮层**：悬停即显、永不裁剪，一处生效全部 tooltip。
     * 数据源仍是各处既有的 `data-tip` 属性 —— 组件侧写法不变（只是不再挂 `.tooltip` 类）。
     */
    const [tip, setTip] = createSignal<{ text: string; el: HTMLElement } | null>(null);

    /**
     * 悬停导航上的任务项时，在其右侧弹出的「任务详情」覆盖层（值是任务 uri）。
     *
     * 三个刻意的选择：
     *  1. **覆盖层**（absolute，不挤压主区）—— 这是「顺便看一眼」的动作，鼠标移开就还原；
     *     若做成分栏挤压，看一眼的代价是整页内容跳一下
     *  2. 展开态与收起态（rail）都能触发 —— 收起态只有序号图标，同样需要看一眼确认
     *  3. 离开导航项后**延迟**隐藏（HOVER_HIDE_MS），鼠标要时间跨到覆盖层上；
     *     进覆盖层即取消（见 cancelHideHoverTask），否则手还没到面板就没了
     */
    const [hoverTaskUri, setHoverTaskUri] = createSignal<string | null>(null);
    /** 任务树标题的单层预览 drawer：left 是相对 mainAreaEl 的 x，宽度取触发 view 的宽度 */
    const [hoverTreeTask, setHoverTreeTask] = createSignal<{ uri: string; left: number; width: number } | null>(null);
    const HOVER_HIDE_MS = 180;
    /** 任务管理表格行 hover 预览的固定宽度（行本身接近整页宽，不能按行宽铺开） */
    const HOVER_TREE_W = 320;
    let hoverHideTimer: ReturnType<typeof setTimeout> | undefined;
    const showHoverTask = (uri: string | null | undefined) => {
        if (!uri) return;
        /* 只有「该任务正是此刻在看的那一个」才不弹详情覆盖层（##183 C-1 的原意）：
           它的详情已在屏上，hover 再弹一层 = 同屏两份。
           ⚠️ 不能写成 `find(task-run:<uri>)`（凡是开在 nav 里的都跳）—— 那样
           「已开但没在看」的任务 hover 也全没了（用户反馈「导航 hover 丢了」）。
           判据见 tabStore.isTaskDisplayed（响应式：切走/关掉立刻恢复可弹）。 */
        if (tabStore.isTaskDisplayed(uri)) return;
        clearTimeout(hoverHideTimer);
        setHoverTreeTask(null);
        setHoverTaskUri(uri);
    };
    const scheduleHideHoverTask = () => {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = setTimeout(() => {
            setHoverTaskUri(null);
            setHoverTreeTask(null);
        }, HOVER_HIDE_MS);
    };
    const cancelHideHoverTask = () => clearTimeout(hoverHideTimer);
    // 覆盖层可见期间强制保持展开：否则鼠标移向覆盖层时会离开侧栏 → 侧栏收拢
    // → drawer-content（以及贴在它左缘的覆盖层）跟着左移，画面抖一下。
    // 注意：**不能**把 hoverTreeTask 也算作「该展开」—— tree drawer 是主区内的 overlay，
    // 展开侧栏会让主区整体右移，把鼠标下的标题链接挪走（指针落到 nav 上）→ drawer 刚开就被收掉。
    const expanded = () => pinned() || hovered() || resizingNav() || !!hoverTaskUri() || navDragging();

    /**
     * 清空悬停覆盖层。**任何「切页面」的动作都要调它**：
     * 点击那一刻鼠标并没有 leave，光靠 mouseleave 收拢会留下「页面已切走、面板还在」的残影。
     */
    const hideHoverLayers = () => {
        clearTimeout(hoverHideTimer);
        setHoverTaskUri(null);
        setHoverTreeTask(null);
    };

    /**
     * 侧栏高亮：**同一时刻只有一处**。
     * 任务执行页时不高亮「任务管理」—— 高亮交给具体任务 tab（否则会同时亮两个，
     * 让人分不清「当前在哪」）。
     */
    const navActive = (): string | null => {
        const r = route();
        return r.kind === "section" ? r.section : null;
    };

    /** 当前激活的 tab key（无则 ""） */
    const activeKey = () => {
        const r = route();
        return r.kind === "tab" ? r.key : "";
    };

    /** tab 标题：优先任务标题，退化到 URI 末段 */
    const tabLabel = (uri: string) => {
        const n = findNode(taskStore.nodes, uri);
        return n?.num ? `#${n.num} ${n.title ?? uri}` : (n?.title ?? uri);
    };

    let fsAbort: AbortController | undefined;

    onMount(() => {
        // 祖先链现算：任务树是父子关系的唯一真相源，tabStore 只存 { pageId, ctx }。
        // 注入后树一变（loadTree / 文件监听 / 拖拽改父）→ opened 重算 → 排序与缩进自动跟上。
        tabStore.setAncestorsResolver(taskAncestorsOf);
        taskStore.loadTree();

        // ── 页内查找（##234）──
        // 搜索根 = 主内容区（不含面包屑/侧栏/查找条自身）
        findStore.setRoot(mainAreaEl);
        // ⌘/Ctrl+F：打开页内查找并聚焦（全局；任务树搜索不再抢这个键，见 TaskTree）
        const onFindKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
                e.preventDefault();
                // 弹层开着时页内查找让位（review3 R3-1b）：FindBar 是主区内的**流内**元素、
                // 无层级，会被弹层 z-500 全屏遮罩压住 —— 开了也看不见点不到，像「⌘F 没反应」。
                // 模态优先；关掉弹层再按即可。按住不放的连发也只响应首次（R3-2）。
                if (e.repeat || navSearchOpen()) return;
                findStore.openFind();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                // ⌘K：快速打开会话（##254）。当前空闲键位 —— 全局只占用了 ⌘F（页内查找）。
                // 开合都走这一个分支（弹出层自己也监听 Esc）；preventDefault 挡住浏览器默认行为。
                e.preventDefault();
                // 按住不放会 keydown 连发 → 高频开合（R3-2），只认首次。
                if (e.repeat) return;
                // 与 nav 入口按钮同处置：打开时先收掉 hover 层，避免弹层背后留着
                // nav hover 详情（review1 RV-2：两条路径此前不一致）。
                hideHoverLayers();
                setNavSearchOpen((v) => !v);
            } else if (e.key === "Escape" && findStore.open) {
                findStore.close();
            }
        };
        window.addEventListener("keydown", onFindKey);
        onCleanup(() => window.removeEventListener("keydown", onFindKey));

        // 任务「血缘树 / 任务管理表格行」悬停 → 只开一层详情 drawer（复用 TaskSideView），
        // 尽力贴在触发行/所在 view 的右侧（贴不下就放左侧，两侧都不行贴主区右缘）。
        // 不在 drawer 里再开 drawer：overlay 实例禁用 hoverPreview，只保留一层。
        const onTreePreview = (detail: { uri: string; rect: { left: number; right: number; width: number } }) => {
            const host = mainAreaEl;
            if (!detail?.uri || !host) return;
            const main = host.getBoundingClientRect();
            const width = Math.min(Math.round(detail.rect.width), Math.round(main.width));
            const roomRight = main.right - detail.rect.right;
            const roomLeft = detail.rect.left - main.left;
            // 优先贴右边；右侧不够才放左侧。
            let left: number;
            if (roomRight >= width) left = detail.rect.right - main.left;
            else if (roomLeft >= width) left = detail.rect.left - main.left - width;
            // 两侧都放不下（如任务管理表格行几乎占满主区）→ 贴主区右缘，别直接不弹
            else left = Math.max(0, Math.round(main.width - width));
            // mousemove 在行内连续派发：同一个 URI 已经是当前唯一 drawer 时不重设对象，
            // 否则每帧都重建 TaskSideView，会把标题 tooltip / 鼠标 hover 连续打断。
            const current = hoverTreeTask();
            if (current?.uri === detail.uri) {
                clearTimeout(hoverHideTimer);
                return;
            }
            clearTimeout(hoverHideTimer);
            setHoverTaskUri(null);
            setHoverTreeTask({ uri: detail.uri, left: Math.max(0, Math.round(left)), width });
        };
        // 用 document 原生委托接 hover：链接藏在复用 view 的 For 节点内，
        // per-node handler 容易被组件复用/重排的事件代理时序吞掉；data 属性只声明 URI，
        // drawer 的单层状态仍统一由 App 管。
        const onDocumentMouseOver = (ev: MouseEvent) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            const link = target.closest<HTMLElement>("[data-task-hover-uri]");
            const uri = link?.dataset.taskHoverUri;
            if (!uri) return;
            // 锚点：血缘树里是所在 view（宽度取 view 宽）；任务管理表格行是所在行，
            // 宽度固定 HOVER_TREE_W（行接近整页宽，按行宽会铺满整屏）。
            const view = link.closest<HTMLElement>("[data-task-side-view]");
            const anchor = view ?? link.closest<HTMLElement>("tr[data-uri]") ?? link;
            const r = anchor.getBoundingClientRect();
            const width = view ? r.width : HOVER_TREE_W;
            onTreePreview({ uri, rect: { left: r.left, right: r.right, width } });
        };
        const onDocumentMouseOut = (ev: MouseEvent) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            const link = target.closest<HTMLElement>("[data-task-hover-uri]");
            if (!link) return;
            const next = ev.relatedTarget;
            if (next instanceof Node && link.contains(next)) return;
            scheduleHideHoverTask();
        };
        document.addEventListener("mouseover", onDocumentMouseOver);
        document.addEventListener("mouseout", onDocumentMouseOut);
        // ── 全局 tooltip 委托（读 [data-tip]）──
        const onTipOver = (ev: MouseEvent) => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            const el = t.closest<HTMLElement>("[data-tip]");
            if (!el) {
                if (tip()) setTip(null);
                return;
            }
            if (tip()?.el === el) return; // 同一元素内移动：不重设，免得每帧闪
            setTip({ text: el.dataset.tip ?? "", el });
        };
        const onTipOut = (ev: MouseEvent) => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            const el = t.closest<HTMLElement>("[data-tip]");
            if (!el) return;
            const next = ev.relatedTarget;
            if (next instanceof Node && el.contains(next)) return; // 仍在同一元素内
            setTip(null);
        };
        // 按下即隐：tooltip 与下拉菜单同位（都在触发元素正下方），若点击后仍驻留，
        // fixed z-200 会把 absolute z-20 的菜单盖住 —— 用户「点了没反应，没子菜单」
        // （任务 242 实测：⋯ 菜单 rect 与 tooltip rect 逐像素重叠）。一按下就收，交互即隐。
        const onTipDown = () => {
            if (tip()) setTip(null);
        };
        document.addEventListener("mouseover", onTipOver);
        document.addEventListener("mouseout", onTipOut);
        document.addEventListener("pointerdown", onTipDown);
        onCleanup(() => {
            document.removeEventListener("mouseover", onDocumentMouseOver);
            document.removeEventListener("mouseout", onDocumentMouseOut);
            document.removeEventListener("mouseover", onTipOver);
            document.removeEventListener("mouseout", onTipOut);
            document.removeEventListener("pointerdown", onTipDown);
        });
        setRendererActions({
            navigate: (page) => {
                if (!VALID_PAGES.has(page)) return;
                hideHoverLayers(); // RV-01/06：切页入口统一收悬停层（与 goSection 对齐）
                if (page === "task-run" || page === "lab") {
                    const t = tabStore.activeTab();
                    setRoute(t ? { kind: "tab", key: t.key } : { kind: "section", section: "task" });
                    return;
                }
                if (page === "task") {
                    requestTreeReveal();
                    tabStore.showTree();
                }
                setRoute({ kind: "section", section: page as Section });
            },
            focus: (uri) => taskStore.selectTask(uri),
            // 折叠块展开态按前缀分派：`ctx.*` 归上下文树试验场，其余归提示词页
            setView: (key, open) =>
                key.startsWith("ctx.") ? setCtxLabFold(key, open) : setLabView(key, open),
            setViewArea: (pageId, area, open) => layoutStore.setAreaHidden(pageId, area, !open),
            // view 级隐藏/显示：key = viewId@ctx（context 型）。global 型 view 没有 ctx 维度
            getLayout: (pageId, ctx) => {
                const page = findPage(pageId);
                if (!page) return null;
                const st = layoutStore.pageState(pageId);
                const hidden = Object.keys(st.hidden).filter((k) => st.hidden[k]);
                // hiddenViews：不传 ctx = 看全貌（排障用）；传了 ctx = 只列本实例的
                // （本 page 在本 ctx 下**可能出现的** view 键 = binding 的键集）。
                // 传 null 直接过滤会把 context 型 view 全滤掉（键是 `view@ctx`，空 ctx 对不上），
                // 实测踩到 —— 故「没给 ctx」与「给了空 ctx」必须区分。
                const hiddenViews =
                    ctx === null
                        ? Object.keys(st.hiddenViews).filter((k) => st.hiddenViews[k])
                        : Object.keys(st.hiddenViews).filter(
                              (k) => st.hiddenViews[k] && k in defaultBinding(page, ctx),
                          );
                return {
                    layout: layoutStore.resolve(pageId, page.layout),
                    hidden: hidden.sort(),
                    hiddenViews: hiddenViews.sort(),
                    maximized: st.maximized,
                };
            },
            setLayout: (pageId, changes) => {
                if (changes.cols || changes.rows) {
                    layoutStore.setTracks(pageId, changes.cols, changes.rows);
                }
                if (changes.hide?.length) layoutStore.setAreasHidden(pageId, changes.hide, true);
                if (changes.show?.length) layoutStore.setAreasHidden(pageId, changes.show, false);
                if (changes.maximize !== undefined) layoutStore.setMaximized(pageId, changes.maximize);
            },
            resetLayout: (pageId) => layoutStore.reset(pageId),
            setViewVisible: (pageId, viewId, ctx, visible) => {
                const def = findView(viewId);
                if (!def) return;
                layoutStore.setViewHidden(pageId, viewInstanceKey(def, ctx), !visible);
            },
            openTaskRun: (uri) => {
                hideHoverLayers(); // RV-06：覆盖层里点标题开会话切页 → 层立即收，不等 mouseleave
                tabStore.open("task-run", uri);
                setRoute({ kind: "tab", key: tabStore.active });
            },
            openLab: (uri) => getRendererActions().openTab?.("lab", uri),
            revealTask: (uri) => requestTreeReveal(uri),
            openTab: (pageId, ctx) => {
                tabStore.open(pageId, ctx);
                setRoute({ kind: "tab", key: tabStore.active });
            },
            activateTab: (key) => {
                tabStore.activate(key);
                setRoute({ kind: "tab", key });
            },
            closeTab: (key) => {
                tabStore.close(key);
                const next = tabStore.active;
                setRoute(next ? { kind: "tab", key: next } : { kind: "section", section: "task" });
            },
            toast: (msg, level) => notificationStore.addToast(level ?? "info", msg),
        });
        // 窗口标题 = 实例标识（与 main 创建窗口时那个值同源同格式，见 shared/instance-title）。
        // main 侧拦了「页面标题 → 窗口标题」这条通路，故这里不是为了让窗口标题生效，
        // 而是让 renderer 自己也持有一份：serve 模式的浏览器标签页标题、以及测试断言读它。
        // 数据根展示形式/分支都在 renderer 里拿不到（要真实家目录与 git），故整份事实由 main 下发。
        void diyService.diy.getAppInfo({}).then((r) => {
            document.title = instanceTitle({
                repoDisplay: r.repoDisplay,
                homeDisplay: r.diyHomeDisplay,
                env: r.env,
                branch: r.branch,
                port: r.port,
                pid: r.pid,
            });
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

    /**
     * 侧栏右缘拖拽改宽（松手落盘）。
     *
     * 三个细节都是必需的：
     *  1. 宽度 = 鼠标 x - 侧栏左缘，不能裸用 clientX —— 侧栏不保证从 x=0 起
     *  2. 拖拽期间强制展开（resizingNav）—— 侧栏平时是 hover 展开的，鼠标一移出
     *     右缘就触发展开态收拢，宽度会跟着抖
     *  3. 松手才落盘 —— 拖拽中每帧写 localStorage 是几十次无用写入
     */
    const onNavGripDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const left = navEl?.getBoundingClientRect().left ?? 0;
        setResizingNav(true);
        const move = (ev: MouseEvent) => {
            setNavW(Math.min(NAV_W_MAX, Math.max(NAV_W_MIN, Math.round(ev.clientX - left))));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setResizingNav(false);
            Caches.diy_nav_width.set(navW());
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    const goSection = (id: Section) => {
        hideHoverLayers(); // 页面切走了，悬停层不能留着盖在屏幕上
        if (id === "task") {
            requestTreeReveal(); // 取 ctx 要在 showTree 清空 active 之前（##160）
            tabStore.showTree();
            setRoute({ kind: "section", section: "task" });
            return;
        }
        setRoute({ kind: "section", section: id });
    };

    /** 当前激活的 tab 对象（供主区按 pageId 分派） */
    const activeTabItem = () => tabStore.activeTab();

    /** 打开/聚焦某个 tab（含子页面） */
    const goto = (key: string) => {
        hideHoverLayers();
        tabStore.activate(key);
        setRoute({ kind: "tab", key });
    };

    /** 关闭 tab：与任务状态无关（= 暂时不理会）。关父连带关子 */
    const closeTab = (key: string) => {
        hideHoverLayers();
        // 关闭前记下它的 ctx：关掉最后一个 tab 会落回任务树，那时也应在树里定位到它（##160），
        // 但 tabStore.close 之后 activeTab 已变，取不到了
        const closedCtx = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
        tabStore.close(key);
        const next = tabStore.active;
        if (next) {
            setRoute({ kind: "tab", key: next });
            return;
        }
        if (closedCtx) setTreeReveal({ uri: closedCtx, nonce: (treeReveal()?.nonce ?? 0) + 1 });
        setRoute({ kind: "section", section: "task" });
    };

    return (
        // diy-nav-pinned：pin 锁定时窄窗也占布局列（199），覆盖规则见 index.css
        <div class={`drawer lg:drawer-open ${pinned() ? "diy-nav-pinned" : ""}`}>
            {/* DaisyUI drawer 必须的 checkbox（控制开合，:checked 决定侧栏是否展开） */}
            <input type="checkbox" id="sidebar-toggle" class="drawer-toggle" />
            {/* 主内容区 */}
            <div class="drawer-content flex flex-col h-screen">
                <main
                    class="flex-1 flex flex-col relative overflow-hidden bg-base-100"
                    onClick={() => {
                        hideHoverLayers(); // 空区域点击也顺手收掉悬停层
                        // 点击空白处关闭任务详情面板（任务行/面板自身已 stopPropagation 接管）
                        // 只在任务树页面生效：其他页面点击不应取消选中任务
                        if (route().kind === "section" && (route() as { section: Section }).section === "task" && taskStore.selectedUri) taskStore.selectTask(null);
                    }}
                >
                    
                    {/* 面包屑导航：从当前页面回溯到根，每个非叶子节点带 ▾ 下拉（列出同级 tab） */}
                    <Breadcrumb
                        section={route().kind === "section" ? (route() as { kind: "section"; section: Section }).section : "task"}
                        activeKey={route().kind === "tab" ? (route() as { kind: "tab"; key: string }).key : ""}
                        gotoTab={(key) => {
                            hideHoverLayers();
                            tabStore.activate(key);
                            setRoute({ kind: "tab", key });
                        }}
                        gotoSection={(id) => {
                            hideHoverLayers();
                            if (id === "task") {
                                requestTreeReveal();
                                tabStore.showTree();
                            }
                            setRoute({ kind: "section", section: id as Section });
                        }}
                        closeTab={closeTab}
                    />
                    {/* 页内查找条：动态出现（关掉即消失），不是模态弹窗。放在面包屑与主内容之间，
                        且在 mainAreaEl 之外 —— 查找不搜自己。 */}
                    <FindBar />
                    <div ref={(el) => (mainAreaEl = el)} class="flex-1 min-h-0 overflow-hidden relative">
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "task"}>
                        <TaskTree reveal={treeReveal()} />
                        <TaskDetailPanel />
                    </Show>
                    <Show when={route().kind === "tab" && activeTabItem()?.pageId === "task-run"}>
                        <Show when={activeTabItem()} keyed>
                            {(t) => <TaskRunPage uri={t.ctx ?? ""} />}
                        </Show>
                    </Show>
                    <Show when={route().kind === "tab" && activeTabItem()?.pageId === "lab"}>
                        <Show when={activeTabItem()} keyed>
                            {(t) => <LabPage uri={t.ctx ?? ""} />}
                        </Show>
                    </Show>
                    <Show when={route().kind === "tab" && activeTabItem()?.pageId === "ctxlab"}>
                        <Show when={activeTabItem()} keyed>
                            {(t) => <ContextLabPage uri={t.ctx ?? ""} />}
                        </Show>
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "llm"}>
                        <LlmPage />
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "settings"}>
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
                                        <Tabs.Trigger value="models" class="tab">
                                            🤖 模型
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
                            <Show when={subPage() === "models"}>
                                <ModelConfigPage />
                            </Show>
                        </div>
                    </Show>
                        {/* 悬停导航任务项 → 任务详情覆盖层（overlay，**不挤压主区**）。
                            定位取 left-0 是「nav 右缘」：本容器正是 DaisyUI drawer 的
                            drawer-content，天然紧贴侧栏右缘，不需要手算 nav 宽度。
                            宽度固定 320px（w-80）：它随鼠标出现、跟着鼠标消失，拖宽无意义。 */}
                        <Show when={hoverTaskUri()}>
                            {(uri) => (
                                <aside
                                    data-find-skip
                                    class="absolute inset-y-0 left-0 z-30 w-80 bg-base-100 border-r shadow-2xl flex flex-col"
                                    aria-label={`任务详情：${uri()}`}
                                    onMouseEnter={cancelHideHoverTask}
                                    onMouseLeave={hideHoverLayers}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <TaskSideView uri={uri()} hoverPreview={false} />
                                </aside>
                            )}
                        </Show>
                        <Show when={hoverTreeTask()}>
                            {(preview) => (
                                <aside
                                    data-find-skip
                                    class="absolute inset-y-0 z-30 bg-base-100 border-r shadow-2xl flex flex-col"
                                    style={{ left: `${preview().left}px`, width: `${preview().width}px` }}
                                    aria-label={`任务详情：${preview().uri}`}
                                    onMouseEnter={cancelHideHoverTask}
                                    onMouseLeave={scheduleHideHoverTask}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <TaskSideView uri={preview().uri} hoverPreview={false} />
                                </aside>
                            )}
                        </Show>
                        {/* 全局 tooltip 浮层：fixed，按触发元素定位（下方放不下则翻到上方）。
                            pointer-events-none：绝不挡住鼠标，免得 tooltip 自己触发 mouseout 抖动。 */}
                        <Show when={tip()}>
                            {(t) => {
                                const r = t().el.getBoundingClientRect();
                                const up = r.bottom + 48 > window.innerHeight;
                                const left = Math.max(6, Math.min(r.left, window.innerWidth - 270));
                                return (
                                    <div
                                        class="pointer-events-none fixed z-[200] max-w-64 rounded bg-neutral px-2 py-1 text-body leading-relaxed text-neutral-content shadow-lg"
                                        style={{
                                            left: `${left}px`,
                                            top: `${up ? r.top - 6 : r.bottom + 6}px`,
                                            transform: up ? "translateY(-100%)" : undefined,
                                        }}
                                    >
                                        {t().text}
                                    </div>
                                );
                            }}
                        </Show>
                    </div>
</main>
            </div>

            {/* 侧栏 - DaisyUI drawer。
                DragDropProvider 是纯 context（不产生 DOM），包住侧栏让任务项的
                useDraggable/useDroppable 拿到管理器 —— nav 拖拽改父子（任务 242）。 */}
            <DragDropProvider
                sensors={[PointerSensor]}
                onDragStart={() => {
                    setNavDragging(true);
                    hideHoverLayers(); // 拖拽中不再弹 hover 详情层（幽灵经过别的项会乱）
                }}
                onDragEnd={(e) => {
                    setNavDragging(false);
                    return handleNavDragEnd(e);
                }}
            >
            <div class="drawer-side z-40">
                <label for="sidebar-toggle" class="drawer-overlay" />
                {/* 宽用内联 style：daisyUI .menu{width:fit-content} 是非分层样式，会压住 w-12/w-56 utility
                    收起态同步去掉 menu 的 8px 水平 padding（p-0），否则按钮内容超出 rail 被顶到右侧。

                    `flex-nowrap` 是必需的，不是风格选择：daisyUI .menu 带 `flex-flow:column wrap`，
                    而 **flex-wrap:wrap 容器的交叉轴尺寸取 items 的 max-content** —— 于是宽度从
                    「打开的 tab」一路按内容撑开（实测长标题的 tab 行撑到 501px，侧栏只有 224px），
                    行右侧的关闭按钮跑到侧栏外被 overflow-hidden 裁掉，`elementFromPoint` 命中的是
                    主区内容（即「页面遮挡住关闭按钮、点不到」）。nowrap 让交叉轴回到容器宽度，
                    再配合 `min-w-0` 保证内部的 truncate 能真正收缩。 */}
                {/* 展开宽度可调（拖右缘 / 双击手柄复位）：宽度记在视图 cache，重启恢复。
                    拖拽期间摘掉 transition —— 否则宽度在鼠标后面追，手感是"拖不动"。 */}
                <div
                    ref={(el) => (navEl = el)}
                    class={`menu flex-nowrap bg-base-200 min-h-full whitespace-nowrap overflow-hidden relative ${expanded() ? "p-2" : "p-0"} ${resizingNav() ? "" : "transition-[width,padding] duration-200"}`}
                    style={{ width: expanded() ? `${navW()}px` : "2.5rem" }}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                >
                    {/* 顶栏 = 与面包屑 / 各 view 顶栏同高的 viewbar（VIEW_BAR_H）。
                        原先这里是 h-12 且只有 ◉，而 pin 按钮独占底部一行 —— 两处都与
                        「一律 32px 高、按钮区在右」的统一规格不符。现改为：左 ◉、右按钮区。
                        收起态（rail 40px）装不下按钮区，只留 ◉ 居中。 */}
                    <div
                        class={`flex items-center ${VIEW_BAR_H} border-b shrink-0 ${expanded() ? "justify-between px-2" : "justify-center"}`}
                    >
                        <Show
                            when={expanded()}
                            fallback={
                                /* 收起态（rail 40px）只留品牌图标：按钮区放不下（◉ + 📍 挤在 40px 里），
                                   也没有必要 —— 鼠标移到侧栏即展开，按钮区随之出现，「锁定」是一步之遥。
                                   顺带避开一个陷阱：在收起态放 pin 按钮，点击的按下瞬间侧栏才展开、
                                   按钮已经移位，down/up 落在不同元素上 → 点击不成立（真实点击测试抓到过）。 */
                                <span class="font-bold" title="diy">
                                    ◉
                                </span>
                            }
                        >
                            <span class="font-bold" title="diy">
                                ◉
                            </span>
                            <button
                                class="btn btn-ghost btn-xs px-1 min-h-0 opacity-60 hover:opacity-100"
                                title={pinned() ? "取消锁定（恢复悬停展开）" : "锁定展开"}
                                onClick={() => setPinned(!pinned())}
                            >
                                <span>{pinned() ? "📌" : "📍"}</span>
                            </button>
                        </Show>
                    </div>
                    <div class={`space-y-1 w-full min-w-0 ${expanded() ? "p-1" : "py-2"}`}>
                        {/* ⌘K 快速打开会话（##254）的**可见入口**：展开态是一行「搜索…」伪输入框
                            （与导航项同构的 li，快捷键写在右侧）；收起态是 40px rail 里的 🔍 按钮
                            （装不下文字，与顶栏按钮区同理）。两态都要有 —— 不知道快捷键的人也得点得到。 */}
                        {/* R4-5：收起态（rail）装不下文字，可访问名会退化成只有 🔍 ——
                            `title` 不保证被当作可访问名，故显式给 aria-label。 */}
                        <li class="flex justify-center">
                            <button
                                class={`flex items-center gap-2 w-full transition-colors cursor-pointer ${
                                    expanded() ? "px-3 py-2 rounded-lg" : "h-8 w-8 rounded-lg justify-center"
                                } hover:bg-base-300`}
                                data-testid="nav-search-open"
                                title="搜索任务 / 会话（⌘K）"
                                aria-label="搜索任务 / 会话（⌘K）"
                                onClick={() => {
                                    hideHoverLayers();
                                    setNavSearchOpen(true);
                                }}
                            >
                                <span>🔍</span>
                                <Show when={expanded()}>
                                    <span class="flex-1 text-left opacity-70">搜索…</span>
                                    <kbd class="text-caption opacity-50">⌘K</kbd>
                                </Show>
                            </button>
                        </li>
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
                                            {(t) => {
                                                const isActive = () => activeKey() === t.key;
                                                /** 页面层次的子页面（lab 挂 task-run 下） */
                                                const isSubPage = () => !!t.parent || !!findPage(t.pageId)?.parentPage;
                                                /** 任务层次的缩进层级（已打开的祖先任务个数；0 = 顶级） */
                                                const taskIndent = () => taskIndentOf(t, tabStore.opened);
                                                const num = () => (t.ctx ? findNode(taskStore.nodes, t.ctx)?.num : undefined);
                                                // 非 task-run 的页面 tab 一律用 registry 的 title（避免"新页面忘了加特判"
                                                // 就显示成所属任务名 —— R3 那个 bug 的成因；见 review RV-05）。
                                                // task-run 例外：它代表任务本体，显示任务名而非页面名。
                                                const label = () => {
                                                    const def = findPage(t.pageId);
                                                    if (def && t.pageId !== "task-run")
                                                        return `${def.title}${num() ? ` #${num()}` : ""}`;
                                                    return tabLabel(t.ctx ?? "");
                                                };
                                                // 图标同样走 registry（RV-10）：别在组件里特判 pageId ——
                                                // 新页面忘记加特判就会重复 R3 那个 bug；无 icon 时退回页面序号。
                                                const icon = () => findPage(t.pageId)?.icon ?? (num() ?? "•");
                                                const tabGoto = () => {
                                                    hideHoverLayers();
                                                    tabStore.activate(t.key);
                                                    setRoute({ kind: "tab", key: t.key });
                                                };
                                                /** 缩进：页面子页面一级 + 每个已打开的祖先任务一级 */
                                                const indentPx = () => 28 + (isSubPage() ? 12 : 0) + taskIndent() * 14;
                                                const isNested = () => isSubPage() || taskIndent() > 0;
                                                // nav 拖拽改父子（任务 242）：带任务上下文的 tab 都可拖/可放
                                                // （lab 提示词页也有 ctx=挂的任务；dnd id 用 tab key —— 同一任务
                                                // 可开多个 tab，uri 会撞 id）。只挂展开态（收起态看不出标题，不支持拖）。
                                                const drag = useDraggable({
                                                    get id() {
                                                        return t.key;
                                                    },
                                                    get data() {
                                                        return { title: label(), kind: "nav-task" };
                                                    },
                                                });
                                                const drop = useDroppable({
                                                    get id() {
                                                        return t.key;
                                                    },
                                                });
                                                const dndRef = (el: Element | undefined) => {
                                                    drag.ref(el);
                                                    drop.ref(el);
                                                };
                                                return (
                                                    <li class="flex justify-center">
                                                        <Show
                                                            when={expanded()}
                                                            fallback={
                                                                <button
                                                                    class={`relative flex items-center justify-center h-8 w-8 rounded-lg text-caption font-mono transition-colors cursor-pointer ${
                                                                        isActive()
                                                                            ? "bg-primary/30 ring-1 ring-primary/40 font-semibold"
                                                                            : "hover:bg-base-300 opacity-70"
                                                                    }`}
                                                                    title={label()}
                                                                    onClick={tabGoto}
                                                                    onMouseEnter={() => {
                                                                        if (!navDragging()) showHoverTask(t.ctx);
                                                                    }}
                                                                    onMouseLeave={scheduleHideHoverTask}
                                                                >
                                                                    {icon()}
                                                                    {/* 收起态装不下缩进，用一个小角标表达「有父」 */}
                                                                    <Show when={isNested()}>
                                                                        <span class="absolute left-0.5 bottom-0.5 text-caption opacity-50">↳</span>
                                                                    </Show>
                                                                </button>
                                                            }
                                                        >
                                                            <div
                                                                ref={dndRef}
                                                                class={`group flex items-center gap-1 w-full pr-1 py-1 rounded-lg text-body cursor-pointer transition-colors ${
                                                                    isActive() ? "bg-primary/25 ring-1 ring-primary/30" : "hover:bg-base-300"
                                                                } ${drop.isDropTarget() ? "ring-2 ring-primary/60 ring-inset" : ""}`}
                                                                style={{ "padding-left": `${indentPx()}px` }}
                                                                title={t.ctx ?? t.key}
                                                                onClick={tabGoto}
                                                                onMouseEnter={() => {
                                                                    if (!navDragging()) showHoverTask(t.ctx);
                                                                }}
                                                                onMouseLeave={scheduleHideHoverTask}
                                                            >
                                                                {/* 缩进用竖线引导（比箭头更清楚地表示「挂在上面那项之下」）；
                                                                    状态圆点始终保留 —— 缩进与状态是两件事，不该二选一 */}
                                                                <Show when={isNested()}>
                                                                    <span class="w-1.5 shrink-0 self-stretch border-l border-base-content/25" />
                                                                </Show>
                                                                <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${taskStateColor(findNode(taskStore.nodes, t.ctx ?? "")?.state)}`} />
                                                                <span class="truncate flex-1">{label()}</span>
                                                                <button
                                                                    class="btn btn-ghost btn-xs px-1 opacity-0 group-hover:opacity-70 hover:!opacity-100 shrink-0"
                                                                    title={isSubPage() ? "关闭该子页面" : "关闭（暂时不理会，不影响任务状态）"}
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        closeTab(t.key);
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
                    {/* 右缘拖拽条：调宽 + 双击复位。收起态（rail）没有可调的宽度，不渲染 */}
                    <Show when={expanded()}>
                        <div
                            class="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
                            title="拖动调整侧栏宽度（双击复位）"
                            onMouseDown={onNavGripDown}
                            onDblClick={() => {
                                setNavW(NAV_W_DEFAULT);
                                Caches.diy_nav_width.set(NAV_W_DEFAULT);
                            }}
                        />
                    </Show>
                </div>
            </div>
            {/* 拖拽幽灵：跟随光标显示「正在拖的任务标题」（TaskTree 同款视觉） */}
            <DragOverlay>
                {(source) =>
                    source?.data?.title ? (
                        <div class="flex items-center px-3 py-1 text-prose bg-base-100 border rounded shadow-lg opacity-80 max-w-[200px] pointer-events-none select-none">
                            <span class="truncate">{String(source.data.title)}</span>
                            <span class="ml-2 text-body opacity-60">拖放改层级</span>
                        </div>
                    ) : null
                }
            </DragOverlay>
            </DragDropProvider>

            {/* ⌘K 快速打开会话（##254）：结果单位是**任务**（diy 里任务与会话 1:1），
                选中即开/聚焦该任务的会话 tab —— 不经过任务管理详情。 */}
            <NavSearch
                open={navSearchOpen()}
                onClose={() => setNavSearchOpen(false)}
                onPick={(uri) => getRendererActions().openTaskRun?.(uri)}
            />

            <ToastContainer />
        </div>
    );
}
