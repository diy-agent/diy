// @ts-nocheck
import { createSignal } from "solid-js";

export type ToastType = "info" | "success" | "error";
export interface Toast { id: string; type: ToastType; message: string; createdAt: number; }

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export const notificationStore = {
  get toasts() { return toasts(); },
  addToast: (type: ToastType, message: string, duration = 4000) => {
    const id = `toast-${nextId++}`;
    const t: Toast = { id, type, message, createdAt: Date.now() };
    setToasts((p) => [...p, t]);
    if (duration > 0) setTimeout(() => notificationStore.removeToast(id), duration);
  },
  removeToast: (id: string) => setToasts((p) => p.filter((t) => t.id !== id)),
};