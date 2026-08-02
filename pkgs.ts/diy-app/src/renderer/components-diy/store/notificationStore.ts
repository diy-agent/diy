// src/renderer/components-diy/store/notificationStore.ts
import { create } from "zustand";

export type ToastType = "info" | "success" | "error";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  createdAt: number;
}

interface NotificationState {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

let nextId = 1;

export const useNotificationStore = create<NotificationState>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = 4000) => {
    const id = `toast-${nextId++}`;
    const toast: Toast = { id, type, message, createdAt: Date.now() };
    set((s) => ({ toasts: [...s.toasts, toast] }));

    if (duration > 0) {
      setTimeout(() => get().removeToast(id), duration);
    }
  },

  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
