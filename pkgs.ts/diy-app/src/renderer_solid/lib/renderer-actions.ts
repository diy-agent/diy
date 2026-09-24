import type { ToastType } from "../store/notificationStore";

/** CLI `ui layout get` 的快照（有效布局 + 用户态偏离项） */
export interface LayoutSnapshot {
    layout: Layout;
    hidden: string[];
    hiddenViews: string[];
    maximized: string | null;
}

/** CLI `ui layout set` 的改动集（字段缺省 = 不动） */
export interface LayoutChanges {
    cols?: TrackSize[];
    rows?: TrackSize[];
    hide?: string[];
    show?: string[];
    maximize?: string | null;
}

import type { Layout, TrackSize } from "../../shared/grid-layout";

export interface RendererActions {
    /** 导航到 page 一级（任务 / LLM / 设置）。非法值忽略，不改变当前视图 */
    navigate?: (page: string) => void;
    /** 在任务树里选中某个任务（弹出任务 view） */
    focus?: (uri: string) => void;
    toast?: (message: string, level: ToastType) => void;
    /** 展开/折叠**折叠框**（view 内部）。注意：与「view 在哪个 area / 是否隐藏」是两件事 */
    setView?: (key: string, open: boolean) => void;
    /** 打开（或聚焦）任务执行 tab —— 等同点任务详情里的大 FAB */
    openTaskRun?: (uri: string) => void;
    /** 切到已打开的 tab（参数是 tab key：`task-run:<uri>` / `lab:<uri>`） */
    activateTab?: (key: string) => void;
    /** 关闭 tab（= 暂时不理会，与任务状态无关；关父连带关子） */
    closeTab?: (key: string) => void;
    /** viewarea（承载 view 的面板）开合。area id 有几何语义、无身份语义 */
    setViewArea?: (pageId: string, area: string, open: boolean) => void;
    /** view 级**隐藏/显示**（某 view 实例在 area 里的去留；实例状态保留）。
     *  与 `setView`（折叠框展开）是两件事。 */
    setViewVisible?: (pageId: string, viewId: string, ctx: string | null, visible: boolean) => void;
    /** 读某 page 实例的有效布局（CLI 用；读取本身不产生副作用） */
    getLayout?: (pageId: string, ctx: string | null) => LayoutSnapshot | null;
    /** 改某 page 的布局（只改指定项；CLI `ui layout set`） */
    setLayout?: (pageId: string, changes: LayoutChanges) => void;
    /** 回到开发者默认布局 */
    resetLayout?: (pageId: string) => void;
    /** 打开提示词页（**子页面**，挂在同任务的任务执行 tab 之下） */
    openLab?: (uri: string) => void;
    /** 通用：打开任意 page 的 tab（CLI `ui tab open [<pageId>:]<uri>` 用）。
     *  子页面会自动挂到同 ctx 的父 page tab 之下。 */
    openTab?: (pageId: string, ctx: string) => void;
}
let _actions: RendererActions = {};
export function setRendererActions(a: RendererActions) { _actions = a; }
export function resetRendererActions() { _actions = {}; }
export function getRendererActions() { return _actions; }
