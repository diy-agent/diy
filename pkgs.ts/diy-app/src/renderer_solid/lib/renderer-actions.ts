import type { ToastType } from "../store/notificationStore";

export interface RendererActions {
    navigate?: (page: string) => void;
    focus?: (uri: string) => void;
    toast?: (message: string, level: ToastType) => void;
    /** 展开/折叠试验场里的某个 view（CLI 自动化要看折叠 view 的内容，见 `ui view set`） */
    setView?: (key: string, open: boolean) => void;
}
let _actions: RendererActions = {};
export function setRendererActions(a: RendererActions) { _actions = a; }
export function resetRendererActions() { _actions = {}; }
export function getRendererActions() { return _actions; }
