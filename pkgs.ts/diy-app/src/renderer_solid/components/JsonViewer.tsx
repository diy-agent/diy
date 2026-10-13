import { createSignal, Show } from "solid-js";
import { JsonTree } from "./JsonTree";
import { notificationStore } from "../store/notificationStore";

/**
 * JSON 查看器：**树 ⇄ 原文** 两态切换（同一份 data，切态不丢上下文）。
 *
 * 「树」= `JsonTree`（逐层折叠、长字符串按真实换行展开）；「原文」= `JSON.stringify(…, 2)`
 * 或原始字符串（SSE / 错误体本身就是文本时不套 JSON.stringify）。
 *
 * 为什么两态都要：树适合「找字段」，原文适合「看字节 / 整段复制」。单给树，用户拿不到
 * 可复制的整体；单给原文，深层结构没法看。故并排一个切换，默认树。
 */
export function JsonViewer(props: { data: unknown }) {
    const [raw, setRaw] = createSignal(false);
    const text = () => {
        const d = props.data;
        if (typeof d === "string") return d;
        try {
            return JSON.stringify(d, null, 2);
        } catch {
            return String(d);
        }
    };
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text());
            notificationStore.addToast("success", "已复制到剪贴板");
        } catch {
            notificationStore.addToast("error", "复制失败（剪贴板不可用）");
        }
    };
    return (
        <div class="flex flex-col h-full min-h-0">
            <div class="flex items-center gap-2 shrink-0 pb-1">
                <div class="join" role="group" aria-label="查看方式">
                    <button
                        class={`btn btn-xs join-item ${raw() ? "btn-ghost" : "btn-active"}`}
                        aria-pressed={!raw()}
                        title="树：逐层折叠的结构视图"
                        onClick={() => setRaw(false)}
                    >
                        树
                    </button>
                    <button
                        class={`btn btn-xs join-item ${raw() ? "btn-active" : "btn-ghost"}`}
                        aria-pressed={raw()}
                        title="原文：完整文本，可整体复制"
                        onClick={() => setRaw(true)}
                    >
                        原文
                    </button>
                </div>
                <button class="btn btn-xs btn-ghost ml-auto" onClick={copy}>
                    复制
                </button>
            </div>
            <div class="min-h-0 flex-1 overflow-auto bg-base-200 rounded p-2">
                <Show when={raw()} fallback={<JsonTree data={props.data} />}>
                    <pre class="whitespace-pre-wrap break-all font-mono text-body leading-relaxed">
                        {text()}
                    </pre>
                </Show>
            </div>
        </div>
    );
}
