import { createSignal, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";

export function LlmPage() {
    const [running, setRunning] = createSignal(false);
    const [loading, setLoading] = createSignal(true);
    const refresh = async () => {
        const s = await diyService.diy.llmProxy.status({});
        setRunning(s.running);
        setLoading(false);
    };
    onMount(refresh);
    const toggle = async () => {
        setLoading(true);
        try {
            if (running()) {
                await diyService.diy.llmProxy.stop({});
                notificationStore.addToast("success", "LLM 代理已停止");
            } else {
                await diyService.diy.llmProxy.start({});
                notificationStore.addToast("success", "LLM 代理已启动");
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : "操作失败";
            notificationStore.addToast("error", msg);
        }
        await refresh();
    };
    return (
        <div class="flex flex-col gap-4 p-4 max-w-xl">
            <h2 class="text-base font-bold">LLM 代理</h2>
            <div class="card border p-4 bg-base-100">
                <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-medium">运行状态</span>
                    <span class={`badge ${running() ? "badge-success" : "badge-ghost"}`}>
                        {loading() ? "检查中…" : running() ? "运行中" : "已停止"}
                    </span>
                </div>
                <Show when={running()}>
                    <div class="text-xs opacity-60 space-y-1">
                        <div>
                            端口: <code>8000</code>
                        </div>
                        <div>
                            地址: <code>http://127.0.0.1:8000</code>
                        </div>
                    </div>
                </Show>
                <button class="btn btn-sm mt-3" disabled={loading()} onClick={toggle}>
                    {loading() ? "处理中…" : running() ? "停止" : "启动"}
                </button>
            </div>
        </div>
    );
}
