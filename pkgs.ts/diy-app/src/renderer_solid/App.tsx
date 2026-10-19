import { createSignal, createMemo, createEffect, on, onMount, onCleanup, untrack, Show, For } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { TaskTree } from "./components/TaskTree";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskRunPage } from "./components/TaskRunPage";
import { LabPage } from "./components/LabPage";
import { LlmPage } from "./components/LlmPage";
import { TrafficPage } from "./components/TrafficPage";
import { SessionOverviewPage } from "./components/SessionOverviewPage";
import { InstancesPage } from "./components/InstancesPage";
import { RoomsPage } from "./components/RoomsPage";
import { SidebarRoom } from "./components/SidebarRoom";
import { SessionChip, SessionDot } from "./components/SessionChip";
import { TaskAgentStateBadge, TaskAgentStateDot } from "./components/TaskAgentState";
import { ModelConfigPage } from "./components/ModelConfigPage";
// 折叠框展开态仍是 lab view 内部的局部状态（与「view 在哪个 area」是两件事）
import { setLabView } from "./components/PromptLabV4Page";
import { ContextLabPage, setCtxLabFold } from "./components/ContextLabPage";
import { FlowPage } from "./components/FlowPage";
import { AppInfo } from "./components/AppInfo";
import { LogPanel } from "./components/LogPanel";
import { ThemeSettings } from "./components/ThemeSettings";
import { ToastContainer } from "./components/ToastContainer";
import { ConfirmDialog } from "./components/ConfirmDialog";
// 「模型不可用」顶栏 bar（##369 ①）：真发失败时把事实从会话流里提出来摆到最显眼处
import { ModelUnavailableBar } from "./components/ModelUnavailableBar";
import { taskStore, type TreeNode } from "./store/taskStore";
import { tabStore } from "./store/tabStore";
import { staleTaskTabCtxs } from "../shared/tab-prune";
import { navPinStore } from "./store/navPinStore";
// 全局会话可见性（##308）：**唯一的注册表订阅**在这里起，nav / 任务表 / 总览页共读同一份。
import { sessionStore } from "./store/sessionStore";
import { layoutStore } from "./store/layoutStore";
import { diyService } from "./lib/rpc";
import { notificationStore } from "./store/notificationStore";
import { modelNoticeStore } from "./store/modelNoticeStore";
import { defaultBinding, findPage, findView, viewInstanceKey } from "../shared/view-registry";
import { taskIndentOf } from "../shared/tab-order";
import { partitionByPin } from "../shared/nav-pin";
import { groupByProject, projectColor, projectIndexOf, projectOfCtx } from "../shared/nav-project";
import { taskStateColor } from "../main/core/task-state";
import { instanceTitle } from "../shared/instance-title";
import { Caches, NAV_W_MIN, NAV_W_MAX, NAV_W_DEFAULT } from "./lib/ui-state";
import { VIEW_BAR_H } from "./lib/layout-metrics";
import { TaskSideView } from "./components/TaskSideView";
import { Breadcrumb } from "./components/Breadcrumb";
import { NAV_SEARCH_SHORTCUT, NavSearch } from "./components/NavSearch";
import { FindBar } from "./components/FindBar";
import { findStore } from "./store/findStore";
import { setRendererActions, resetRendererActions, getRendererActions } from "./lib/renderer-actions";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable, PointerSensor } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { findTaskProject } from "./components/TaskTree";
import { allTaskUris, isAncestorOf } from "./lib/task-lineage";
// 开机扫账本的入队次序（##358 §10）：热点立即 / 冷账本 idle 切片，纯函数
import { scanPlanOf, SCAN_SLICE } from "../shared/session-scan";
// 会话活动语汇（##358 D1/D2）：nav 的主角标 / 次角标 / 「后台活动」区**共用一份**判据
//（纯函数在 shared/session-nav —— 位次仍出自 shared/session-overview，与任务表 / 总览同源）。
import {
    backgroundOf,
    heroBadgeOf,
    navRowOf,
    rankOf,
    rowBadgeOf,
    secondaryBadgeOf,
} from "../shared/session-nav";
import type { NavRow, NavTone } from "../shared/session-nav";
import { ALERT_ACTION_LABEL, alertsOf } from "../shared/session-alerts";
// 「待你处理」区（##358 D5）：判据纯函数；行集仍是上面那份 navRows（两个区**不可能**给出不同结论）
import { todoOf, todoWhenOf } from "../shared/session-todo";
// 相对时间（`20h`）—— 纯函数在 shared/session-overview，与任务表 `fmtStamp` 同处（不另写时间格式）
import { fmtAgo } from "../shared/session-overview";
import { resumeOf, resumeWhenOf } from "../shared/session-resume";
import { usageLedgerStore } from "./store/usageLedgerStore";
import { alertPrefsStore } from "./store/alertPrefsStore";

/**
 * 取"此刻最上面的可查找浮层"（##309）。
 *
 * 全屏抽屉（流量 z-50 / 人物配置 z-70 / 用量 z-50…）都标了 `data-find-surface`，
 * 且是 `fixed inset-0`。页内查找据此**把范围切到最前那一层**：否则抽屉开着时，
 * 会搜到被抽屉盖住、根本看不见的正文（计数虚高、高亮落在遮罩后面）。
 *
 * 判据：可见（有尺寸、非 display:none/visibility:hidden）者中取 **z-index 最大**。
 * 注意 `offsetParent` 对 `position:fixed` 元素恒为 null，不能拿它判可见。
 */
function topFindSurface(): HTMLElement | undefined {
    let best: HTMLElement | undefined;
    let bestZ = -Infinity;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-find-surface]"))) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const z = Number(cs.zIndex);
        const zv = Number.isFinite(z) ? z : 0;
        if (zv >= bestZ) {
            bestZ = zv;
            best = el;
        }
    }
    return best;
}

/**
 * 路由（page 一级 + 任务执行页的实例）。
 *
 * 「任务执行页」不在顶级导航里 —— 它是**动态页面**：每打开一个任务就多一个，
 * 挂在导航「任务」之下（等同浏览器/编辑器开 tab）。故用 route 而不是扁平 page id。
 */
type Section = "task" | "llm" | "traffic" | "sessions" | "rooms" | "instances" | "settings";

/**
 * 路由 = 顶级 section，或一个**已打开的 tab**（key 形如 `task-run:<uri>` / `lab:<uri>`）。
 * 任务执行页与提示词页都是 tab —— 后者是前者的子页面（见 133「一页一中心」）。
 */
type Route = { kind: "section"; section: Section } | { kind: "tab"; key: string };

// dnd-kit/solid 未直接导出 DragEndEvent，从 onDragEnd 回调参数提取（TaskTree 同款）
type DragEndEvent = Parameters<NonNullable<DragDropProviderProps["onDragEnd"]>>[0];

/** 顶级导航（一侧栏项 = 一类事情）。任务执行页不出现在这里，它是任务下的动态页面 */
const NAV_ITEMS: Array<{ id: Section; label: string; icon: string }> = [
    { id: "task", label: "任务管理", icon: "📋" },
    { id: "llm", label: "LLM", icon: "🧠" },
    { id: "traffic", label: "流量", icon: "📡" },
    // 「会话」= 全局消费视图（##308）：不点进任何任务页，也能看到谁在跑、跑到第几步。
    // 放在导航里（而不是藏进某个任务页）正是本任务的验收语言 —— 它是**跨任务**的视图。
    { id: "sessions", label: "会话", icon: "🛰" },
    // 「实例」= 本机 diy 实例大盘（##367）：跨**数据根**的视图，一眼看清现在跑着几个 diy、各自的根/变体/
    // 在干什么，并能把某个窗口全屏请到前台。⚠️ icon 刻意与「任务」（📋）/「会话」（🛰）**明显不同**、
    // 且**不挂任何任务状态**（##350 的教训：长得像任务的子页面会让人以为那是任务列表）。
    // 「房间」= 多人 room（##377 / 设计 ##166 §28）：人 + 多 agent 同室对话的**投递 + 汇总层**。
    // 与「会话」的区别：会话页看的是**每个成员的独立会话**（谁在跑、跑到第几步），
    // 房间看的是「谁对谁说了什么」—— 两者是不同层的东西，刻意并列而不是互相嵌套。
    { id: "rooms", label: "房间", icon: "🏠" },
    { id: "instances", label: "实例", icon: "🖥" },
    { id: "settings", label: "设置", icon: "⚙️" },
];

/** `ui page navigate` 的合法取值（非法值一律忽略：宁可不跳，也不能把主区打成白屏） */
/**
 * nav 角标的**配色**（##358 D1）—— 用户给的口径就是颜色词：
 *   绿 = 未读 / 运行中 · 红 = 未读且异常终止 · 黄 = 停滞 · 紫 = 队列待投递。
 * 只在这里定义一次：主角标与次角标、展开与收起共用（两处各写一份必然漂移）。
 * 绿用 daisyUI 的 `success`（`primary` 在本主题里是蓝紫 —— 与"绿=未读"的口径不符，
 * 故 SessionChip 的颜色表也一并改到 success，见 components/SessionChip.tsx）。
 */
const NAV_TONE_CLASS: Record<NavTone, string> = {
    green: "bg-success/20 text-success border-success/40",
    amber: "bg-warning/20 text-warning border-warning/40",
    red: "bg-error/20 text-error border-error/40",
    purple: "bg-diy-queue/20 text-diy-queue border-diy-queue/40",
};

/** 同一套配色的**文字**形态（「会话」列表行内那个 `+N` 用它：一屏十几个 badge 就是噪声） */
const NAV_TONE_TEXT: Record<NavTone, string> = {
    green: "text-success",
    amber: "text-warning",
    red: "text-error",
    purple: "text-diy-queue",
};

/** 「会话」列表最多列几行：nav 是"扫一眼"的地方，不是账页（更多的折成表尾一句纯文本） */
const NAV_SESSION_LIMIT = 8;

const VALID_PAGES = new Set(["task", "task-run", "lab", "llm", "traffic", "sessions", "rooms", "instances", "settings"]);

/**
 * 窄窗断点。**必须与 index.css 的 `@media (width < 1024px)`、daisyUI 的 `lg:` 分支
 * 三处同值** —— 它们共同决定「侧栏是常驻占列还是被推出画面」。
 *
 * 窄窗下 daisyUI 的 drawer 占位分支（lg:drawer-open）失效：侧栏连 40px rail 一起被推到
 * 画面外（##297），故改由 CSS 的 `.diy-nav-rail` 接管（rail 常驻 + 点开浮层），
 * JS 这边只需知道「现在是不是窄窗」来切换展开语义。
 */
const NARROW_MQ = "(width < 1024px)";

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
    // 窄窗（<1024）两态：isNarrow 由 matchMedia 跟随（见 onMount），railOpen 是
    // 「把 rail 展开成浮层」的开关。窄窗 rail 常驻由 CSS 负责，这里只管浮层这一档 ——
    // 于是侧栏宽度**从不消失**：窄窗最窄 40px rail，宽窗 40px↔224px（##297）。
    const [isNarrow, setIsNarrow] = createSignal(false);
    const [railOpen, setRailOpen] = createSignal(false);
    /**
     * 相对时间的**心跳**（##358 用户 2026-10-19：「改为 20h？会更新吗？如果无法更新，就删掉吧」）。
     *
     * 时间字串本身是纯函数（`fmtAgo`）算出来的，**它自己不会走** —— 必须有东西让界面重算。
     * 这里每分钟推一次 `nowMs`，凡是读了它的渲染就会跟着重算（nav 行的 `20h` → `21h` → `1d`）。
     * 为什么要这个信号而不是在渲染里直接 `Date.now()`：那样只有**别的原因**引起重绘时才顺手更新，
     * 界面静止时时间就冻住了 —— 正是用户担心的情况。1 分钟是刻意的粗粒度：
     * 行内最小单位就是分钟（`刚刚`），再密也看不出差别，只是白烧 CPU。
     */
    const [nowMs, setNowMs] = createSignal(Date.now());

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

    // RV-03（##245 review）：切页后旧页面的查找 Range 随 Solid 卸载退化成 zeroWidth，
    // badge 还挂着过期计数（refresh 全仓零调用）。查找条是**页内**语义 → 换页即关
    // （close 会清 Range/计数/高亮，一步到位）。
    createEffect(on(() => route(), () => findStore.close()));

    /**
     * 树刷新后剪掉「指向已不存在任务」的 tab，并告知用户（##226 接线 + ##361 存在性校验）。
     *
     * 为什么要校验存在性、而不只做「上一轮在、这一轮不在」的 diff：tab 是**持久化**的
     * （`diy_tabs_opened`）—— 跨重启后，盘上仍躺着早就被删掉的任务的 tab；diff 的 prev
     * 首轮为空，永远发现不了它们。判据收在 shared/tab-prune（纯函数、可单测）：
     *   ① 只剪任务是 ctx 的 tab（别的页面 ctx 不动）；
     *   ② **树成功加载过**才剪（treeLoaded）—— 启动那一瞬 nodes=[] 是「树还没到」，
     *      照剪会把用户恢复出来的 tab 全清光。
     *
     * 过期快照的防护在 taskStore.loadTree（旧响应丢弃）：本 effect 读的 nodes 永远是
     * **已生效**的那一份，不会拿旧树误判「任务消失」（见 task-store.test.ts）。
     * `tabStore.opened` 用 untrack 读：剪枝会写 tab，若不 untrack 就自我触发成环。
     */
    createEffect(() => {
        const treeLoaded = taskStore.treeLoaded;
        const nodes = taskStore.nodes;
        const alive = new Set<string>();
        const walk = (ns: TreeNode[]) => {
            for (const n of ns) {
                if (n.uri) alive.add(n.uri); // 项目节点没有 uri，成不了任务的 tab，跳过
                walk(n.children ?? []);
            }
        };
        walk(nodes);
        const opened = untrack(() => tabStore.opened.map((t) => ({ pageId: t.pageId, ctx: t.ctx })));
        const stale = staleTaskTabCtxs({ opened, aliveUris: alive, treeLoaded });
        if (stale.length === 0) return;
        untrack(() => {
            for (const ctx of stale) tabStore.dropCtx(ctx);
            // 被剪的若是任务管理页当前选中的任务 → 清掉选中（面板切到「任务不存在」终态）
            if (taskStore.selectedUri && stale.includes(taskStore.selectedUri)) void taskStore.selectTask(null);
            // 被摘的恰是当前 route → route 悬空（主区所有 page 的 Show 全 false = 白屏）→ 跟随 active
            const r = route();
            if (r.kind === "tab" && !tabStore.find(r.key)) {
                const k = tabStore.active;
                setRoute(k ? { kind: "tab", key: k } : { kind: "section", section: "task" });
            }
            notificationStore.addToast(
                "info",
                stale.length === 1
                    ? `任务 ${stale[0]} 已不存在，已关闭其页面`
                    : `${stale.length} 个任务已不存在，已关闭对应页面`,
            );
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
     * nav 任务项列表 = **置顶项固定在前**（##356 ②）。
     *
     * 只**分区**、不排序：区内顺序仍是 `tabStore.opened` 的全局顺序（任务树序），
     * 故置顶不会打乱父子相邻关系；缩进也照旧由全局层级算（置顶不改层级，
     * 也不隐式把置顶项的祖先一起置顶）。规则本体是纯函数，见 shared/nav-pin。
     */
    const navTabs = createMemo(() => {
        const { pinned, rest } = partitionByPin(tabStore.opened, (t) => t.key, new Set(navPinStore.keys));
        return { all: [...pinned, ...rest], pinnedCount: pinned.length };
    });

    // 关掉的 tab（或其任务被删）不留置顶键：tab 列表一变就剪枝。
    // 语义边界：只剪「键已不存在」的，**不管它现在指什么** —— 同 key 再打开仍是置顶。
    createEffect(() => {
        navPinStore.prune(tabStore.opened.map((t) => t.key));
    });

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
        /* 窄窗**浮层展开时**不弹（##297）：此刻侧栏是盖住主区的固定层（z-40），
           卡片（z-30）弹出来也看不见，只会白建一个 TaskSideView。
           rail 态（窄窗常态）照弹 —— 那与宽窗 rail 态几何完全一致：主区同样从 x=40 起，
           卡片贴主区左缘正好落在 rail 右侧，看得见也点得到。 */
        if (isNarrow() && railOpen()) return;
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
    // 窄窗没有「悬停即展开」这回事：触屏本就没有 hover，鼠标在 rail 上也是点开浮层
    // （展开态盖着主区，鼠标一进来就展开只会自己闪）。故窄窗只看 railOpen。
    // ⚠️ hoverTaskUri 也必须留在宽窗那一支里：它进 expanded() 是为了「鼠标跨到卡片上时
    // 侧栏别收」（宽窗的卡片靠侧栏展开才贴着它右缘）。窄窗 rail 态没有「展开」这回事 ——
    // 卡片贴的是主区左缘（与 rail 无关），一旦把它算进去，hover 一次侧栏就从 40px 弹到
    // 224px，收缩逻辑全乱。resizingNav / navDragging 是两态共有的「拖拽期间保持展开」项。
    const expanded = () =>
        resizingNav() ||
        navDragging() ||
        (isNarrow() ? railOpen() : pinned() || hovered() || !!hoverTaskUri());

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
     * 窄窗：主区被切走时收掉浮层。
     *
     * 窄窗浮层是**固定盖在主区上**的一层，且没有宽窗那条 mouseleave 兜底
     * （宽窗「悬停即展开」→ 鼠标一移开就自己收）—— 不显式收，选完导航项浮层还盖在
     * 主区上，用户得再点一次遮罩。宽窗无浮层可收（no-op）。
     */
    const collapseRail = () => {
        if (isNarrow()) setRailOpen(false);
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

    /**
     * 已读水位：**正在看**的那条会话追到当前轮次 —— 它是"距上次看新增多少条未读消息"的基线
     * （##308；##358 口径订正：1 轮 = 1 条消息，不是步数）。
     *
     * 只追激活的 task-run tab（不是"开着就算"）：`isTaskDisplayed` 的语义就是"在屏上"，
     * 与 hover 覆盖层用的是同一条判据。读了 `entries` 让注册表帧到达时重跑（水位随轮次前进）。
     *
     * ⚠️ 本 effect 里**只许读**、不许写（自读自写会自我入队 → 无限递归，##308 review3 P1-1）：
     * `markViewed` 内部对水位读做了 `untrack`，故这里可以安全地在 tracked 作用域里调它。
     * 详见 sessionStore.markViewed 的注释与 tests/core/session-store.test.ts。
     */
    createEffect(() => {
        const t = tabStore.activeTab();
        if (t?.pageId !== "task-run" || !t.ctx) return;
        // 读一次条目表 = **订阅注册表帧**：帧到了本 effect 就重跑，把水位追到最新
        //（不读它的话，轮次涨了水位还停在打开那一刻，"未读"会一路涨成假信号）。
        if (sessionStore.entries.length === 0) return;
        sessionStore.markViewed(t.ctx);
    });

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

    /**
     * nav 视角下的会话行（##358 D1/D2 的输入）。
     *
     * `opened` 由**开着哪些 tab**决定：开着 = 已在视线内，不必再提示；关掉 = 才有「回到视线」这回事。
     * 判据（未读 / 停滞 / 异常）不在本文件算 —— 走 `navRowOf`（shared/session-nav），
     * 位次全部出自 shared/session-overview，于是 nav 与任务表、总览页**不可能给出不同结论**。
     */
    /**
     * 行集 = **任务树里的全部任务** ∪ 注册表（##358 D5/D4）。
     *
     * 为什么不是"只注册表"：注册表是**进程性**的（重启即空），而那正是用户的痛点
     * ——「app 启动后丢了所有进度」。任务树是 renderer 本来就有的全量清单，
     * 配上**账本**（落盘、跨启动）就能在启动那一刻回答"哪些会话我还没看"。
     * 代价：开机扫一遍各任务账本（N 次小文件读，`usageLedgerStore` 有并发 4 + 永久缓存兜着）。
     * ⚠️ 水位**不**给它们建基线（见 `sessionStore.ensureBaseline` 的调用点只在注册表入口）——
     * 建了就等于"第一眼即已读"，历史欠账会当场清零。
     */
    const navUris = createMemo(() => {
        const us = new Set<string>(allTaskUris(taskStore.nodes));
        for (const { uri } of sessionStore.rows) us.add(uri);
        return [...us];
    });

    /**
     * 开机扫账本的**入队次序**（##358 §10）：热点立即、冷账本 idle 切片慢慢补。
     *
     * 为什么不是"一次性全量入队"（上一版）：队列是 FIFO + 并发 4 ⇒ 第一眼要看的几行
     * 排在几百个老账本之后，**数字迟到**（看着像没算）。次序由 `scanPlanOf`（纯函数）给，
     * **不丢任何任务** —— 「待你处理」是全局聚合，砍掉冷任务 = 看不见历史欠账。
     */
    const scanPlan = createMemo(() => {
        const opened = new Set(tabStore.opened.filter((t) => t.ctx).map((t) => t.ctx!));
        const inRegistry = new Set(sessionStore.rows.map((r) => r.uri));
        return scanPlanOf(
            navUris().map((uri) => {
                const n = findNode(taskStore.nodes, uri);
                return {
                    uri,
                    opened: opened.has(uri),
                    inRegistry: inRegistry.has(uri),
                    state: n?.state,
                    updated: n?.updated,
                };
            }),
        );
    });

    // 冷账本补扫：idle 一次一片（幂等 —— 已读到的任务 `ensure` 自己会跳过，故不必记"扫到哪了"）
    onMount(() => {
        const scanned = new Set<string>();
        let stopped = false;
        let scheduled = false; // 防叠加：任务树连变时只保留一条待跑的定时链
        const idle = (fn: () => void) => {
            const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
                .requestIdleCallback;
            if (ric) ric(fn, { timeout: 1200 });
            else window.setTimeout(fn, 60);
        };
        const pending = () => scanPlan().cold.filter((u) => !scanned.has(u));
        const schedule = () => {
            if (stopped || scheduled) return;
            scheduled = true;
            idle(drain);
        };
        function drain() {
            scheduled = false;
            if (stopped) return;
            const batch = pending().slice(0, SCAN_SLICE);
            if (batch.length === 0) return; // 扫完一轮；navUris 再变时由下面的 effect 重新踢一脚
            for (const u of batch) scanned.add(u);
            usageLedgerStore.ensure(...batch);
            schedule();
        }
        createEffect(() => {
            const plan = scanPlan();
            usageLedgerStore.ensure(...plan.hot); // 热点：立刻（幂等）
            if (plan.cold.length > 0) schedule();
        });
        onCleanup(() => {
            stopped = true;
        });
    });

    const navRows = createMemo(() => {
        const opened = new Set(tabStore.opened.filter((t) => t.ctx).map((t) => t.ctx!));
        return navUris().map((uri) =>
            navRowOf({
                uri,
                label: tabLabel(uri),
                opened: opened.has(uri),
                entry: sessionStore.byUri(uri), // 账本独有行 → null（不是错误）
                seenTurns: sessionStore.seenTurnsOf(uri),
                totalTurns: sessionStore.turnsOf(uri),
                lastTs: usageLedgerStore.lastTsOf(uri) ?? null,
                maxSteps: sessionStore.maxSteps,
                now: sessionStore.nowMs,
            }),
        );
    });
    /** nav 上那**一个**主角标（同一时刻只出一个；判据见 shared/session-nav::heroBadgeOf） */
    const navHero = createMemo(() => heroBadgeOf(navRows()));
    /** 主角标之外的次角标（现在是队列：紫） */
    const navSecondary = createMemo(() => secondaryBadgeOf(navRows(), navHero()));
    /** 「待你处理」区 = 有一笔账在等你（异常终止 / 卡住 / 有人在等 / 跑完没看） */
    const navTodo = createMemo(() => todoOf(navRows()));
    /**
     * 「后台活动」区 = 没开着 tab、但有活态的会话（关掉 ≠ 消失）。
     * **减掉已被「待你处理」收走的那批** —— 同一会话绝不两处同时出现（否则用户要数两遍）。
     * 减完剩下的基本就是"在跑、不用你回话"（##305 关了也在跑）。
     */
    const navBackground = createMemo(() => {
        const taken = new Set(navTodo().map((i) => i.row.uri));
        return backgroundOf(navRows()).filter((r) => !taken.has(r.uri));
    });

    /**
     * 「继续工作」区（##358 D4）= **最近活动过、眼下没事**的会话，按最后活动时间倒序。
     *
     * 用户第一句原话就是它：「app 启动后丢了所有进度……我要接着工作、知道最近我在干啥」。
     * 尺子是**账本最后一条账**（跨启动），所以**重启后本区不空** —— 这正是"进度没丢"的直接证据；
     * `lastTs` 为空（没聊过）不进本区，也**不编时间**。
     * 去重：前两区已收走的 uri 传进去（同一会话在 nav 只有一处）；开着 tab 的也不列。
     */
    const navResume = createMemo(() => {
        const taken = [...navTodo().map((i) => i.row.uri), ...navBackground().map((r) => r.uri)];
        return resumeOf(navRows(), taken);
    });

    /**
     * **「会话」项下那一份列表**（用户 2026-10-19 合并口径）：上面三份数据取并集，按"值不值得看"排序。
     *
     * 判据**一个都没改**（`todoOf` / `backgroundOf` / `resumeOf` 仍是各自那件事的答案），
     * 改的只是呈现：不再分三个带标题和计数的区（那些标题长得像按钮、点了没反应 —— 用户明确否掉）。
     * 行 = 状态点 + 标题 + `+N` + 最后活动时间；`why` 只进 tooltip（不占行高，否则括号比内容还长）。
     */
    const navSessionList = createMemo(() => {
        const rows: Array<{ row: NavRow; kind: "todo" | "running" | "recent"; why: string; when: string }> = [];
        for (const i of navTodo()) rows.push({ row: i.row, kind: "todo", why: i.why, when: todoWhenOf(i) });
        for (const r of navBackground())
            rows.push({
                row: r,
                kind: "running",
                why: r.stalled ? "在跑，但长时间没动静" : "在跑（没开窗口也在跑）",
                when: resumeWhenOf(r),
            });
        for (const r of navResume().items)
            rows.push({ row: r, kind: "recent", why: "最近在这儿干过", when: resumeWhenOf(r) });
        rows.sort(
            (a, b) =>
                rankOf(a.row) - rankOf(b.row) ||
                (b.row.lastTs ?? "").localeCompare(a.row.lastTs ?? "") ||
                a.row.uri.localeCompare(b.row.uri),
        );
        return { items: rows.slice(0, NAV_SESSION_LIMIT), more: Math.max(0, rows.length - NAV_SESSION_LIMIT) };
    });

    /** 打开/聚焦某个会话（toast 的「回到」与 L2 自动拉回共用一跳） */
    const openSessionByUri = (uri: string) => {
        hideHoverLayers();
        collapseRail(); // 窄窗：先把浮层收回，别让刚拉回的会话被盖住
        getRendererActions().openTaskRun?.(uri);
    };

    /**
     * ── D3 三级提示（L1 toast + [回到] / L2 自动拉回）─────────────────────────────
     * L0（常驻角标、不打断）就是上面那两个 memo 的渲染；这里管的是**"该不该打断"**。
     *
     * 判据全在 `shared/session-alerts`（纯函数 + 单测）：只对**跃迁**出提示 ——
     * 「现在有 3 条未读」是状态不是事件，拿状态当事件就会一启动糊一脸、且每 tick 反复弹。
     * 谁配得上抢焦点（L2）也只有两种：**异常终止** 与 **有人在等你回复**（队列里刚出现留言）。
     */
    let alertPrev: Record<string, NavRow> = {};
    createEffect(() => {
        const rows = navRows();
        const alerts = alertsOf(alertPrev, rows, { autoPull: alertPrefsStore.autoPull });
        // ⚠️ 先落基线再动手：`openSessionByUri` 会改 tabStore ⇒ navRows 重算 ⇒ 本 effect 再跑一次，
        // 那一跑必须看到"已处理过"的 prev，否则同一条提示弹两遍（真跑过的坑：自动拉回 = 无限弹）。
        alertPrev = Object.fromEntries(rows.map((r) => [r.uri, r]));
        for (const a of alerts) {
            if (a.autoPull) openSessionByUri(a.uri); // L2：抢焦点（仅异常终止 / 有人在等）
            notificationStore.addToast(
                a.kind === "failed" ? "error" : a.kind === "finished" ? "success" : "info",
                a.text,
                a.level === "L2" && a.autoPull ? 0 : 10000, // 抢过焦点的那条必须被看见/点掉；其余 10s 自己走
                { label: ALERT_ACTION_LABEL, onClick: () => openSessionByUri(a.uri) },
            );
        }
    });

    /** 关 tab 前要确认的那一个（在跑的会话：##305 轮次脱离连接，关掉只是不看） */
    const [pendingClose, setPendingClose] = createSignal<{ key: string; label: string } | null>(null);

    let fsAbort: AbortController | undefined;

    // 相对时间心跳（见 nowMs 的注释）：1 分钟推一次，界面静止时 `20h` 也会自己变 `21h`
    onMount(() => {
        const t = setInterval(() => setNowMs(Date.now()), 60_000);
        onCleanup(() => clearInterval(t));
    });

    onMount(() => {
        // 祖先链现算：任务树是父子关系的唯一真相源，tabStore 只存 { pageId, ctx }。
        // 注入后树一变（loadTree / 文件监听 / 拖拽改父）→ opened 重算 → 排序与缩进自动跟上。
        tabStore.setAncestorsResolver(taskAncestorsOf);
        taskStore.loadTree();

        // 窄窗跟随视口（含 serve 模式下的浏览器窗口缩放 / 手机横竖屏）。跨回宽窗时
        // 顺手关掉浮层态：否则再回窄窗会「浮层还开着、遮罩盖着主区」。
        const narrowMq = window.matchMedia(NARROW_MQ);
        const onNarrowChange = () => {
            setIsNarrow(narrowMq.matches);
            if (!narrowMq.matches) setRailOpen(false);
        };
        onNarrowChange();
        narrowMq.addEventListener("change", onNarrowChange);
        onCleanup(() => narrowMq.removeEventListener("change", onNarrowChange));

        // ── 页内查找（##234）──
        // 搜索根 = 主内容区（不含面包屑/侧栏/查找条自身）
        findStore.setRootResolver(() => topFindSurface() ?? mainAreaEl);
        // ⌘/Ctrl+F：打开页内查找并聚焦（全局；任务树搜索不再抢这个键，见 TaskTree）
        const onFindKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
                e.preventDefault();
                // 全局搜索（⌘K 的 NavSearch）开着时让位：它是**自己的输入框**在等人打字，
                // 再叠一层查找条只会打架。除此之外**一律可开** —— 查找条已上提到顶层
                // （Z_FIND），流量/人物配置这类全屏抽屉不再盖住它（##309 修）。
                // 按住不放的连发也只响应首次（R3-2）。
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
        // 全局会话可见性（##308）：注册表订阅只此一处（R3：多一处订阅就多一份漂移源）；
        // 目的一 = nav 角标 / 任务表 chip / 总览页三处同源，二 = 不点进任务页也知道谁在跑。
        sessionStore.start();
        // 「模型不可用」通知订阅（##369 ①）：main 侧真发失败时推一条 → 顶栏 bar。
        // 只此一处订阅（与 sessionStore 同原则：多一处订阅 = 多一处漂移源）。
        modelNoticeStore.start();
    });
    onCleanup(() => {
        fsAbort?.abort();
        sessionStore.stop();
        modelNoticeStore.stop();
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
        collapseRail(); // 窄窗：浮层也一起收（见 collapseRail）
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

    /**
     * nav 任务分区的**项目分组**（##302）：显示层重排 —— 把同项目的 tab 挪到一起，
     * 组内保持 navTabs 的顺序（缩进 / 父子相邻语义因此不受影响）。项目显示名从任务树
     * 现查（projectIndexOf），故树刷新后组头文案自动跟上。
     *
     * 与置顶（##356 ②）的合流：喂进去的是 `navTabs().all`（**置顶项固定在前**），
     * 于是「钉住的项在最上面」原样成立 —— 它所在的**组**也跟着排到最前（组是整体：
     * 不能只把组里一行提到别的组前面而不拆散分组）。组内顺序同样是 navTabs 的顺序，
     * 分隔线按组内 pinnedCount 画（见 groupByProject 的 pinned 参数）。
     * 副作用：置顶会让**该项目的整组**上移 —— 这是「分组」与「置顶」不可兼得处的取舍，
     * 已在任务 body 标为待拍板项。
     */
    const navProjectGroups = createMemo(() =>
        groupByProject(navTabs().all, projectIndexOf(taskStore.nodes), new Set(navPinStore.keys)),
    );

    /** 打开/聚焦某个 tab（含子页面） */
    const goto = (key: string) => {
        hideHoverLayers();
        collapseRail(); // 窄窗：浮层也一起收
        tabStore.activate(key);
        setRoute({ kind: "tab", key });
    };

    /** 关闭 tab：与任务状态无关（= 暂时不理会）。关父连带关子 */
    const closeTab = (key: string, opts?: { skipConfirm?: boolean }) => {
        // 关掉一个**正在跑**的会话：弹一次确认（##358 D3 / demo v4「① 关 tab 时若还在跑」）。
        // 不是拦你 —— 是告诉你"关掉只是不看它，轮次照跑（##305）"，免得以为关了就停了。
        // 走应用内 ConfirmDialog（**禁** window.confirm：窗口级模态会卡住整个渲染进程，且自动化点不到）。
        const ctx = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
        if (!opts?.skipConfirm && ctx && sessionStore.byUri(ctx)?.turn !== null) {
            setPendingClose({ key, label: tabLabel(ctx) });
            return;
        }
        doCloseTab(key);
    };

    /** 真正执行关闭（确认过后走这里） */
    const doCloseTab = (key: string) => {
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
        // diy-nav-rail / diy-nav-rail-open：窄窗 rail 常驻占列 + 点开浮层（##297），
        // 覆盖规则见 index.css。宽窗不需要额外类：lg:drawer-open 已让侧栏占列。
        <>
        <div
            class={`drawer lg:drawer-open ${
                isNarrow() ? `diy-nav-rail${railOpen() ? " diy-nav-rail-open" : ""}` : ""
            }`}
        >
            {/* DaisyUI drawer 必须的 checkbox（控制开合，:checked 决定侧栏是否展开） */}
            <input type="checkbox" id="sidebar-toggle" class="drawer-toggle" />
            {/* 主内容区。窄窗浮层展开时置 inert：浮层把主区整个盖住，但 DOM 里主区的
                按钮仍可 Tab 到、回车也照样触发（看不见的焦点 = 一点就中的坑）；
                inert 同时挡掉命中测试。宽窗与 rail 态不受影响（rail 只占 40px，主区可用）。 */}
            <div
                class="drawer-content flex flex-col h-screen"
                inert={isNarrow() && railOpen()}
            >
                <main
                    class="flex-1 flex flex-col relative overflow-hidden bg-base-100"
                    onClick={() => {
                        hideHoverLayers(); // 空区域点击也顺手收掉悬停层
                        // 点击空白处关闭任务详情面板（任务行/面板自身已 stopPropagation 接管）
                        // 只在任务树页面生效：其他页面点击不应取消选中任务
                        if (route().kind === "section" && (route() as { section: Section }).section === "task" && taskStore.selectedUri) taskStore.selectTask(null);
                    }}
                >
                    {/* 「模型不可用」顶栏 bar（##369 ①）：**页面最上方**（面包屑之上）——
                        真 LLM 实验跑不成时，用户不必翻会话就该看到；可关闭、不挡内容、不中断流程。 */}
                    <Show when={modelNoticeStore.notice}>
                        {(n) => (
                            <ModelUnavailableBar
                                notice={n()}
                                onDismiss={() => modelNoticeStore.dismissCurrent()}
                                onConfigure={() => {
                                    // "去配置模型" = 设置 → 模型（唯一要做的动作；顺带把 route 切过去）
                                    goSection("settings");
                                    setSubPage("models");
                                }}
                            />
                        )}
                    </Show>
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
                    {/* 页内查找条：动态出现（关掉即消失），不是模态弹窗。它自己 Portal 到 body
                        顶层（Z_FIND），**不在流内占位**；这里只是挂载点。查找不搜自己（data-find-skip）。 */}
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
                    <Show when={route().kind === "tab" && activeTabItem()?.pageId === "flow"}>
                        <Show when={activeTabItem()} keyed>
                            {(t) => <FlowPage uri={t.ctx ?? ""} />}
                        </Show>
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "llm"}>
                        <LlmPage />
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "traffic"}>
                        <TrafficPage />
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "sessions"}>
                        <SessionOverviewPage />
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "rooms"}>
                        <RoomsPage />
                    </Show>
                    <Show when={route().kind === "section" && (route() as { section: Section }).section === "instances"}>
                        <InstancesPage />
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
                {/* 遮罩：宽窗恒透明（daisyUI drawer-open 覆盖）；窄窗由 index.css 置
                    pointer-events:none，**只在浮层展开态**可见可点 → 点空白收回侧栏（##297）。
                    preventDefault 是必需的：`<label for>` 默认会顺手切 `#sidebar-toggle`，
                    而那是 daisyUI 的另一套状态（`:checked` → `--page-scroll-lock` 锁根滚动），
                    与 railOpen 双头跑必然脱同步。窄窗的开合只认 railOpen。 */}
                <label
                    for="sidebar-toggle"
                    class="drawer-overlay"
                    onClick={(e) => {
                        if (!isNarrow()) return;
                        e.preventDefault();
                        setRailOpen(false);
                    }}
                />
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
                        data-testid="nav-viewbar"
                        class={`relative flex items-center ${VIEW_BAR_H} border-b shrink-0 ${expanded() ? "justify-between px-2" : "justify-center"}`}
                    >
                        {/* 窄窗（<1024）：◉ 就地变成**唯一的导航入口**（点击把 40px rail 展开成浮层）。
                            **绝对定位钉在左侧 40px 区中心**是必需的：位置在展开前后完全不变 ——
                            否则按下的瞬间侧栏展开、按钮移位，down/up 落在不同元素上，真实点击不成立
                            （这正是下方 fallback 注释里那条「收起态别放按钮」的坑）。
                            展开态右侧再加一个 ✕：遮罩之外也给一条明确的退路（触屏上尤其）。 */}
                        <Show when={isNarrow()}>
                            <button
                                type="button"
                                data-testid="nav-rail-toggle"
                                class="absolute left-0 top-0 z-10 flex h-full w-10 cursor-pointer items-center justify-center font-bold hover:bg-base-300"
                                title={railOpen() ? "收起导航" : "展开导航"}
                                aria-label={railOpen() ? "收起导航" : "展开导航"}
                                aria-expanded={railOpen()}
                                onClick={() => setRailOpen(!railOpen())}
                            >
                                ◉
                            </button>
                            <Show when={railOpen()}>
                                <button
                                    type="button"
                                    data-testid="nav-rail-close"
                                    class="ml-auto cursor-pointer px-1 text-caption opacity-60 hover:opacity-100"
                                    title="收起导航"
                                    aria-label="收起导航"
                                    onClick={() => setRailOpen(false)}
                                >
                                    ✕
                                </button>
                            </Show>
                        </Show>
                        {/* 宽窗：◉ 只是品牌标识 + 右侧按钮区的 pin（常驻展开）。窄窗不需要 pin ——
                            rail 常驻本身就已经是「占一列」的语义（那正是 pin 当年在窄窗想做的事）。 */}
                        <Show when={!isNarrow()}>
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
                                // R6-1：快捷键文案（title / aria-label / <kbd>）与弹层 footer 同源，
                                // 不再各写各的 —— 非 mac 用户也得看得见 Ctrl+K。
                                title={`搜索任务 / 会话（${NAV_SEARCH_SHORTCUT}）`}
                                aria-label={`搜索任务 / 会话（${NAV_SEARCH_SHORTCUT}）`}
                                onClick={() => {
                                    hideHoverLayers();
                                    collapseRail(); // 窄窗：⌘K 弹层要占满屏，先把浮层收了
                                    setNavSearchOpen(true);
                                }}
                            >
                                <span>🔍</span>
                                <Show when={expanded()}>
                                    <span class="flex-1 text-left opacity-70">搜索…</span>
                                    <kbd class="text-caption opacity-50">{NAV_SEARCH_SHORTCUT}</kbd>
                                </Show>
                            </button>
                        </li>
                        <For each={NAV_ITEMS}>
                            {(item) => (
                                <>
                                    <li class="flex justify-center">
                                        {/* tab 式选中指示：当前页加高亮胶囊 + 左侧指示条，收起态也可见 */}
                                        <button
                                            class={`relative flex items-center gap-2 w-full transition-colors cursor-pointer ${expanded() ? "px-3 py-2 rounded-lg" : "h-8 w-8 rounded-lg justify-center"} ${navActive() === item.id ? "bg-primary/30 text-base-content font-semibold ring-1 ring-primary/40" : "hover:bg-base-300"}`}
                                            title={
                                                item.id === "sessions"
                                                    ? `会话（在跑 ${sessionStore.workingCount} / 本次启动活跃过 ${sessionStore.entries.length}）` +
                                                      (navHero() ? `\n${navHero()!.tip}` : "")
                                                    : item.label
                                            }
                                            onClick={() => goSection(item.id)}
                                        >
                                            <span>{item.icon}</span>
                                            {expanded() && <span>{item.label}</span>}
                                            {/* 「会话」项的**主角标**（##358 D1，取代 ##308 的"在跑数"）。
                                                用户原话：`+23` 未读 · 绿色=未读 · 红色=未读异常终止 · **闪烁绿=运行中**。
                                                同一时刻**只出一个**（收起态 40px rail 装不下第二个）——
                                                优先级 停滞 > 运行中 > 异常未读 > 未读 > 队列，判据在 shared/session-nav。
                                                其余信息进 tooltip（点标题可看），队列降成下面的次角标。 */}
                                            <Show when={item.id === "sessions" && navHero()}>
                                                {(hero) => (
                                                    <span
                                                        class={`badge border badge-xs font-mono whitespace-nowrap ${NAV_TONE_CLASS[hero().tone]} ${
                                                            hero().pulse ? "animate-pulse" : ""
                                                        } ${expanded() ? "ml-auto" : "absolute -top-0.5 -right-0.5 px-1"}`}
                                                        title={hero().tip}
                                                        data-nav-hero={hero().key}
                                                    >
                                                        {expanded() ? hero().text : hero().short}
                                                    </span>
                                                )}
                                            </Show>
                                            {/* 次角标：主角标之外还想让你知道的那件事（现在只有队列，紫）。
                                                刻意只给数 —— 展开态也塞不下第二段文字。 */}
                                            <Show when={item.id === "sessions" && navSecondary()}>
                                                {(sec) => (
                                                    <span
                                                        class={`badge border badge-xs font-mono whitespace-nowrap ${NAV_TONE_CLASS[sec().tone]} ${
                                                            expanded() ? "" : "absolute -bottom-0.5 -right-0.5 px-1"
                                                        }`}
                                                        title={sec().tip}
                                                        data-nav-secondary={sec().key}
                                                    >
                                                        {sec().text}
                                                    </span>
                                                )}
                                            </Show>
                                        </button>
                                    </li>
                                    {/* 「任务管理」下的动态页面：每个打开的任务一项（等同编辑器开 tab）。
                                        **展开与收缩两态结构一致** —— 收缩态用「序号」图标承载同样的
                                        层级与选中语义（收缩态不显示标题与关闭按钮，装不下）。 */}
                                    <Show when={item.id === "task"}>
                                        <For each={navProjectGroups()}>
                                            {(g) => (
                                                <>
                                                    {/* 项目分组标题（##302）：**仅展开态** —— rail（40px）装不下文字，
                                                        那一态靠每行左缘的项目色条区分（同一个颜色 = 同一个项目）。
                                                        组序 = 该组在 navTabs（置顶项在前）里的首次出现位置，组内保持 navTabs 顺序、
                                                        置顶项在组内最前 —— 缩进 / 父子相邻语义因此不受影响。 */}
                                                    <Show when={expanded()}>
                                                        <li class="flex justify-center">
                                                            <div
                                                                class="flex items-center gap-1.5 w-full min-w-0 px-3 pt-2 pb-0.5 text-caption opacity-60 select-none"
                                                                data-nav-project-head={g.project?.id ?? ""}
                                                                title={g.project ? (g.project.path ?? g.project.label) : "没有项目归属的页面"}
                                                            >
                                                                <Show when={g.project}>
                                                                    {(p) => (
                                                                        <span
                                                                            class="w-1.5 h-1.5 rounded-full shrink-0"
                                                                            style={{ "background-color": projectColor(p().id) }}
                                                                        />
                                                                    )}
                                                                </Show>
                                                                <span class="truncate">📁 {g.project?.label ?? "未归属项目"}</span>
                                                            </div>
                                                        </li>
                                                    </Show>
                                                    <For each={g.tabs}>
                                                        {(t, i) => {
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
                                                        collapseRail(); // 窄窗：浮层也一起收
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
                                                    /** 置顶态（##356 ②）：投影自 navPinStore，切换即写视图 cache（跨重启保持） */
                                                    const pinned = () => navPinStore.has(t.key);
                                                    return (
                                                        <>
                                                            {/* 置顶区与普通区之间一条细分隔线（##356 ②；**##302 之后按组内计**）：
                                                                分组后置顶项仍是各组的前缀（组序由 navTabs 决定 —— 含置顶项的组排在最前），
                                                                故分隔线画在**本组**置顶段的末尾；本组无置顶项时不出现。 */}
                                                            <Show when={g.pinnedCount > 0 && i() === g.pinnedCount}>
                                                                <li class="px-1 py-0.5" aria-hidden="true">
                                                                    <div class="border-t border-base-content/15" />
                                                                </li>
                                                            </Show>
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
                                                                        data-nav-project={projectOfCtx(t.ctx)}
                                                                        data-nav-tab={t.ctx ?? t.key}
                                                                        onClick={tabGoto}
                                                                        onMouseEnter={() => {
                                                                            if (!navDragging()) showHoverTask(t.ctx);
                                                                        }}
                                                                        onMouseLeave={scheduleHideHoverTask}
                                                                    >
                                                                        {/* 项目归属（##302）：收起态没有组头文字，**色条是唯一的归属线索**
                                                                            （同一个颜色 = 同一个项目；展开态的组头色点同色）。贴在左缘 ——
                                                                            ##355 的 agent 状态点在 left-0.5，色条占 left-0 的 2px，两者相邻不叠。 */}
                                                                        <Show when={projectOfCtx(t.ctx)}>
                                                                            <span
                                                                                class="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                                                                                style={{ "background-color": projectColor(projectOfCtx(t.ctx)) }}
                                                                            />
                                                                        </Show>
                                                                        {icon()}
                                                                        {/* 收起态装不下缩进，用一个小角标表达「有父」 */}
                                                                        <Show when={isNested()}>
                                                                            <span class="absolute left-0.5 bottom-0.5 text-caption opacity-50">↳</span>
                                                                        </Show>
                                                                        {/* agent 面状态点（##355）：rail 装不下文案，退成一个点
                                                                            （颜色即语义，全文在 title 里）。占**左上**角、与右上角的
                                                                            ##308 会话点并存（两条轴各占一角，不互相盖）。 */}
                                                                        <Show when={t.ctx}>
                                                                            <TaskAgentStateDot
                                                                                uri={t.ctx!}
                                                                                hasSession={findNode(taskStore.nodes, t.ctx!)?.has_session}
                                                                                hasDraft={findNode(taskStore.nodes, t.ctx!)?.has_draft}
                                                                                class="absolute top-0.5 left-0.5"
                                                                            />
                                                                        </Show>
                                                                        {/* 会话状态点（##308）：rail 是常驻可见的那一态，
                                                                            最该一眼看到的正是"这条会话在烧/有留言"。全文在 title（SessionDot 内）。 */}
                                                                        <Show when={t.ctx}>
                                                                            <SessionDot uri={t.ctx!} class="absolute top-0.5 right-0.5" />
                                                                        </Show>
                                                                    </button>
                                                                }
                                                            >
                                                                <div
                                                                    ref={dndRef}
                                                                    class={`relative group flex items-center gap-1 w-full pr-1 py-1 rounded-lg text-body cursor-pointer transition-colors ${
                                                                        isActive() ? "bg-primary/25 ring-1 ring-primary/30" : "hover:bg-base-300"
                                                                    } ${drop.isDropTarget() ? "ring-2 ring-primary/60 ring-inset" : ""}`}
                                                                    style={{ "padding-left": `${indentPx()}px` }}
                                                                    title={t.ctx ?? t.key}
                                                                    data-nav-project={projectOfCtx(t.ctx)}
                                                                    data-nav-tab={t.ctx ?? t.key}
                                                                    onClick={tabGoto}
                                                                    onMouseEnter={() => {
                                                                        if (!navDragging()) showHoverTask(t.ctx);
                                                                    }}
                                                                    onMouseLeave={scheduleHideHoverTask}
                                                                >
                                                                    {/* 项目归属（##302）：左缘色条 —— 与分组标题的色点同色，
                                                                        行离组头很远（滚过一屏）时仍读得出「我属哪一组」。 */}
                                                                    <Show when={projectOfCtx(t.ctx)}>
                                                                        <span
                                                                            class="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                                                                            style={{ "background-color": projectColor(projectOfCtx(t.ctx)) }}
                                                                        />
                                                                    </Show>
                                                                    {/* 缩进用竖线引导（比箭头更清楚地表示「挂在上面那项之下」）；
                                                                        行首标记的取舍见下：任务 tab 是状态圆点，子页面 tab 是页面图标 */}
                                                                    <Show when={isNested()}>
                                                                        <span class="w-1.5 shrink-0 self-stretch border-l border-base-content/25" />
                                                                    </Show>
                                                                    {/* 行首标记：**是任务还是页面**的唯一视觉判据（##350 ①）。
                                                                        任务 tab = 任务状态圆点（颜色即状态）；
                                                                        子页面 tab（lab / ctxlab / flow）= 注册表的页面图标，**不标任务状态** ——
                                                                        子页面挂的 ctx 只是"哪个任务的"，它自己不是任务；标了状态圆点就会被读成"又一个任务"。
                                                                        外层定宽 w-4：两种标记同宽，混排时标题左缘才对得齐。
                                                                        会话 chip/dot（##308）不在此列 —— 那是"这条会话在烧"的会话态，与"这是不是任务"是两件事。 */}
                                                                    <span class="flex w-4 shrink-0 items-center justify-center">
                                                                        <Show
                                                                            when={isSubPage()}
                                                                            fallback={
                                                                                <span
                                                                                    class={`w-1.5 h-1.5 rounded-full ${taskStateColor(findNode(taskStore.nodes, t.ctx ?? "")?.state)}`}
                                                                                    data-task-state-dot
                                                                                />
                                                                            }
                                                                        >
                                                                            <span class="font-mono text-caption opacity-80" data-subpage-icon>
                                                                                {icon()}
                                                                            </span>
                                                                        </Show>
                                                                    </span>
                                                                    {/* 内容（那行文字）。**语义钩子 `data-nav-label` 是给测试定点的**（##373）：
                                                                        行内**绝对定位的装饰节点**（##302 项目色条 left-0、##355 状态点）都排在它前面，
                                                                        而 `querySelector('span')` 取的是「第一个 span」= 实现序而非契约 ——
                                                                        ##302 插色条后，缩进用例量到色条（恒等于行左缘）→ `12 > 12` 恒红。
                                                                        要量内容的左边界就取它，别再按标签取第一个元素。 */}
                                                                    <span class="truncate flex-1" data-nav-label>
                                                                        {label()}
                                                                    </span>
                                                                    {/* agent 面状态（##355）：四态单轴一句话。与任务表行、
                                                                        属性面板**同一份判据**（shared/task-agent-state + lib/agent-state）；
                                                                        两个逐任务真源取自任务树节点（main 侧算的）。 */}
                                                                    <Show when={t.ctx}>
                                                                        <TaskAgentStateBadge
                                                                            uri={t.ctx!}
                                                                            iconOnly
                                                                            hasSession={findNode(taskStore.nodes, t.ctx!)?.has_session}
                                                                            hasDraft={findNode(taskStore.nodes, t.ctx!)?.has_draft}
                                                                        />
                                                                    </Show>
                                                                    {/* 会话状态 chip（##308）：与任务表行、总览页**同一份判据**（sessionStore.chipOf） */}
                                                                    <Show when={t.ctx}>
                                                                        <SessionChip uri={t.ctx!} iconOnly />
                                                                    </Show>
                                                                    {/* 置顶开关（##356 ②）：置顶项常显 📌（一眼看出为什么它在最上面），
                                                                        普通项 hover 才显 📍。收起态（rail）不渲染 —— 40px 装不下，
                                                                        但排序与缩进在 rail 态同样生效。 */}
                                                                    <button
                                                                        class={`btn btn-ghost btn-xs px-1 shrink-0 ${
                                                                            pinned()
                                                                                ? "opacity-80 hover:!opacity-100"
                                                                                : "opacity-0 group-hover:opacity-70 hover:!opacity-100"
                                                                        }`}
                                                                        title={pinned() ? "取消置顶" : "置顶（固定在上部）"}
                                                                        data-testid="nav-tab-pin"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            navPinStore.toggle(t.key);
                                                                        }}
                                                                    >
                                                                        {pinned() ? "📌" : "📍"}
                                                                    </button>
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
                                                        </>
                                                        );
                                                        }}
                                                    </For>
                                                </>
                                            )}
                                        </For>
                                    </Show>
                                    {/* ── 「会话」项下的会话列表（##358 D1/D2/D4/D5 合成一份）──────
                                        用户 2026-10-19 口径：「把待处理任务放到『会话』按钮下，去掉多余的修饰词
                                        『待你处理』『3』」「后台活动是啥？……去掉吧，进行中任务直接列在会话下，
                                        和待处理任务一起，**通过活动的状态来表达**」。
                                        所以这里**没有分区、没有区标题、没有计数** —— 行本身就是状态：
                                        status 圆点（在跑=绿+aura 流光 · 未读=绿 · 未读且异常终止=红 · 停滞=黄 · 其余=灰）
                                        + 标题 + `+N`（仅未读时）+ 最后活动时间。
                                        行集仍是三份数据的**并集**（有一笔账在等你 ∪ 在跑 ∪ 最近活动过 ——
                                        判据各自没变，变的是"怎么摆"），按"值不值得看"排序（`rankOf`）。
                                        收起态（rail 40px）不列行：那时主角标就是全部语义。 */}
                                    <Show when={item.id === "sessions" && expanded()}>
                                        <For each={navSessionList().items}>
                                            {(i) => {
                                                const r = () => i.row;
                                                const b = () => rowBadgeOf(r());
                                                const go = () => {
                                                    hideHoverLayers();
                                                    collapseRail(); // 窄窗：浮层收回，把主区让给刚打开的会话
                                                    getRendererActions().openTaskRun?.(r().uri);
                                                };
                                                const dot = () =>
                                                    r().stalled
                                                        ? "status-warning"
                                                        : r().abnormal && r().unread > 0
                                                          ? "status-error"
                                                          : r().unread > 0
                                                            ? "status-success"
                                                            : "";
                                                const tip = () =>
                                                    `${r().label}\n${i.why}${i.when ? `\n最后活动：${i.when}` : ""}\n（点一下 → 回到这个会话）`;
                                                return (
                                                    <li class="flex justify-center">
                                                        <button
                                                            class="group flex items-center gap-2 w-full pl-6 pr-2 py-1 rounded-lg text-body cursor-pointer hover:bg-base-300"
                                                            title={tip()}
                                                            data-nav-session={r().uri}
                                                            data-nav-session-kind={i.kind}
                                                            onClick={go}
                                                        >
                                                            {/* 在跑 = daisyUI 的 `aura`（一圈缓慢流转的光）+ 闪烁的 status。
                                                                用户点名的表达方式：「通过活动的状态来表达，比如 …/components/aura/」。 */}
                                                            <Show
                                                                when={r().running}
                                                                fallback={
                                                                    <Show
                                                                        when={dot()}
                                                                        fallback={
                                                                            /* 没有活态 = **已对话、没有新消息**（用户口径里的"灰色图标"）。
                                                                               原来是一个无色 status 圆点 —— 实心灰点跟"离线/未开始"分不开，
                                                                               用户直接问了「灰色图标和绿色图标啥区别？」
                                                                               改成**暗色会话气泡**：形状说明"这是个会话"，
                                                                               暗说明"聊过但没事"；亮色实心点则恒表示"有东西等你看"。 */
                                                                            <span
                                                                                class="shrink-0 opacity-40 inline-flex"
                                                                                title={`${r().label}：已对话（没有新消息）`}
                                                                                data-nav-session-idle="1"
                                                                            >
                                                                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                                                                    <path d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v7A1.5 1.5 0 0 1 13.5 12H7l-3.6 2.7A.6.6 0 0 1 2.4 14V3.5A1.5 1.5 0 0 1 3.9 2z" />
                                                                                </svg>
                                                                            </span>
                                                                        }
                                                                    >
                                                                        <span class={`status ${dot()}`} />
                                                                    </Show>
                                                                }
                                                            >
                                                                <span class="aura aura-dual text-success shrink-0">
                                                                    <span class="status status-success animate-pulse" />
                                                                </span>
                                                            </Show>
                                                            <span class="truncate flex-1 text-left">{r().label}</span>
                                                            <Show when={b()}>
                                                                {(bd) => (
                                                                    <span
                                                                        class={`font-mono text-caption shrink-0 ${NAV_TONE_TEXT[bd().tone]}`}
                                                                        title={bd().tip}
                                                                    >
                                                                        {bd().short}
                                                                    </span>
                                                                )}
                                                            </Show>
                                                            {/* 时间用**相对格式**（`20h`），读 `nowMs()` ⇒ 每分钟自己往前走；
                                                                tooltip 里仍给绝对时刻（要精确时看那里）。 */}
                                                            <span
                                                                class="font-mono text-caption opacity-50 shrink-0"
                                                                title={i.when ? `最后活动：${i.when}` : undefined}
                                                                data-nav-session-ago={fmtAgo(r().lastTs, nowMs())}
                                                            >
                                                                {fmtAgo(r().lastTs, nowMs())}
                                                            </span>
                                                        </button>
                                                    </li>
                                                );
                                            }}
                                        </For>
                                        {/* 表尾这句是**纯文本**（不是按钮）：点了没反应的控件才是问题 */}
                                        <Show when={navSessionList().more > 0}>
                                            <li class="px-3 pb-1 text-caption opacity-50" data-nav-session-more>
                                                还有 {navSessionList().more} 条
                                            </li>
                                        </Show>
                                        {/* 「自动拉回」开关（D3 的 L2）——原先挂在「后台活动」区标题行上，区没了就搬到这里。
                                            它是**真按钮**（点了会变），不是装饰。 */}
                                        <li class="flex items-center px-3 pt-1 pb-0.5">
                                            <button
                                                class="text-caption opacity-50 hover:opacity-100 cursor-pointer"
                                                data-nav-autopull={alertPrefsStore.autoPull ? "on" : "off"}
                                                title={
                                                    alertPrefsStore.autoPull
                                                        ? "自动拉回：开。只有「异常终止」和「有人在等你回复」会抢焦点开 tab；其余一律只提示。"
                                                        : "自动拉回：关。现在一律只弹提示（带「回到」按钮），不抢焦点。"
                                                }
                                                onClick={() => alertPrefsStore.setAutoPull(!alertPrefsStore.autoPull)}
                                            >
                                                自动拉回 {alertPrefsStore.autoPull ? "开" : "关"}
                                            </button>
                                        </li>
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

            {/* 关掉在跑的会话前的确认（走应用内弹窗，见 closeTab 注释） */}
            <Show when={pendingClose()}>
                {(p) => (
                    <ConfirmDialog
                        title="它还在后台跑，确定关掉？"
                        message={`${p().label} 这一轮还没跑完。关掉只是不看它 —— 轮次会照常在后台跑完（##305 轮次脱离连接），跑完会提示你。`}
                        confirmLabel="关掉（不看）"
                        onCancel={() => setPendingClose(null)}
                        onConfirm={() => {
                            const k = p().key;
                            setPendingClose(null);
                            closeTab(k, { skipConfirm: true });
                        }}
                    />
                )}
            </Show>
            <ToastContainer />
        </div>
        {/* 全局侧边栏助手 room（##166 §30 / §31）：**独立于路由** ——
            挂在 drawer 之外，免得 drawer 的布局/变换影响它的 fixed 定位。 */}
        <SidebarRoom />
        </>
    );
}
