import { For } from "solid-js";
import { notificationStore, type ToastType } from "../store/notificationStore";

const typeStyle: Record<ToastType, string> = {
    info: "alert-info",
    success: "alert-success",
    error: "alert-error",
};

export function ToastContainer() {
    return (
        <div class="toast toast-top toast-end z-[9999]">
            <For each={notificationStore.toasts}>
                {(t) => (
                    <div class={`alert ${typeStyle[t.type]} flex justify-between gap-2 min-w-64`}>
                        <span>{t.message}</span>
                        <button
                            class="btn btn-ghost btn-xs"
                            onClick={() => notificationStore.removeToast(t.id)}
                        >
                            ✕
                        </button>
                    </div>
                )}
            </For>
        </div>
    );
}
