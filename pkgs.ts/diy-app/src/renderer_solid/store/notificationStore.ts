import { createSignal } from "solid-js";

export type ToastType = "info" | "success" | "error";
/** toast 上的一个动作按钮（##358 D3 的 `[回到]`）—— 提示不该逼用户自己去翻 nav */
export interface ToastAction { label: string; onClick: () => void; }
export interface Toast {
    id: string;
    type: ToastType;
    message: string;
    createdAt: number;
    /** 有动作按钮（如 `[回到]`）：想让它"点完再走"就传 `duration = 0`，见 `addToast` */
    action?: ToastAction;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export const notificationStore = {
    get toasts() { return toasts(); },
    /**
     * @param duration 毫秒；**`0` = 不自动消失**（抢过焦点的会话提示用它 —— 得让人看见或点掉）
     */
    addToast: (type: ToastType, message: string, duration = 4000, action?: ToastAction) => {
        const id = `toast-${nextId++}`;
        const t: Toast = { id, type, message, createdAt: Date.now(), action };
        setToasts((p) => [...p, t]);
        if (duration > 0) setTimeout(() => notificationStore.removeToast(id), duration);
    },
    removeToast: (id: string) => setToasts((p) => p.filter((t) => t.id !== id)),
};
