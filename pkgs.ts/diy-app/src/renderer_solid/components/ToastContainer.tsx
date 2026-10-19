import { For, Show } from "solid-js";
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
                    // data-toast：自动化的稳定落点（按 `.toast .alert-*` 找也能找到，但那依赖 daisyUI 的类名）
                    <div class={`alert ${typeStyle[t.type]} flex justify-between gap-2 min-w-64`} data-toast={t.type}>
                        <span>{t.message}</span>
                        {/* 有动作按钮的 toast 不自动消失（见 notificationStore.addToast）：按钮先点、再关 */}
                        <Show when={t.action}>
                            {(a) => (
                                <button
                                    class="btn btn-ghost btn-xs"
                                    data-toast-action={a().label}
                                    onClick={() => {
                                        a().onClick();
                                        notificationStore.removeToast(t.id);
                                    }}
                                >
                                    {a().label}
                                </button>
                            )}
                        </Show>
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
