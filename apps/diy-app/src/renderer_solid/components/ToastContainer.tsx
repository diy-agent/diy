import { For, Show } from "solid-js";
import { notificationStore, type ToastType } from "../store/notificationStore";
import { NoticeDetail } from "./NoticeDetail";

const typeStyle: Record<ToastType, string> = {
    info: "alert-info",
    success: "alert-success",
    error: "alert-error",
};

/**
 * 角标提示容器。**一级只留一句话，二级全在 `[详情]` 里**（##391 R2）：
 * 用户原话「不然我也不知道 app 在干啥，提示这个是啥意思，详情里需要介绍机制」——
 * 所以每条 toast 都带 `[详情]`（来源 / 原因 / 机制 + 复制），不再有"只给结论"的提示。
 */
export function ToastContainer() {
    return (
        <div class="toast toast-top toast-end z-[9999]">
            <For each={notificationStore.toasts}>
                {(t) => (
                    // data-toast：自动化的稳定落点（按 `.toast .alert-*` 找也能找到，但那依赖 daisyUI 的类名）
                    <div
                        class={`alert ${typeStyle[t.type]} flex justify-between gap-2 min-w-64`}
                        data-toast={t.type}
                        data-toast-legacy={t.legacy ? "1" : undefined}
                    >
                        <span>
                            {t.message}
                            {/* 聚合次数（同源密集发生才出现）：只留一条，别拿重复文案刷屏 */}
                            <Show when={t.count > 1}>
                                <span class="ml-1 opacity-70" data-toast-count={t.count}>
                                    ×{t.count}
                                </span>
                            </Show>
                        </span>
                        <div class="flex shrink-0 items-center gap-1">
                            {/* 二级信息入口（来源 / 原因 / 机制）—— ##391 起每条提示都有 */}
                            <NoticeDetail meta={t} message={t.message} when={t.createdAt} label="详情" />
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
                            <button class="btn btn-ghost btn-xs" onClick={() => notificationStore.removeToast(t.id)}>
                                ✕
                            </button>
                        </div>
                    </div>
                )}
            </For>
        </div>
    );
}
