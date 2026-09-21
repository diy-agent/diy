import type { ToastType } from "../store/notificationStore";

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
    /** 切到已打开的 tab */
    activateTab?: (uri: string) => void;
    /** 关闭 tab（= 暂时不理会该任务，与任务状态无关） */
    closeTab?: (uri: string) => void;
    /** viewarea（承载 view 的面板）开合。area id 有几何语义、无身份语义 */
    setViewArea?: (area: string, open: boolean) => void;
}
let _actions: RendererActions = {};
export function setRendererActions(a: RendererActions) { _actions = a; }
export function resetRendererActions() { _actions = {}; }
export function getRendererActions() { return _actions; }
