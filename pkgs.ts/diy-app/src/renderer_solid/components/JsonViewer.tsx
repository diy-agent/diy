import { createSignal, Show } from "solid-js";
import { JsonTree } from "./JsonTree";
import { notificationStore } from "../store/notificationStore";
import { copyFailMeta, copyOkMeta } from "../lib/notice-copy";

/**
 * JSON 查看器：**树 ⇄ 原文** 两态切换（同一份 data，切态不丢上下文）。
 *
 * 顶部是一条统一的操作栏（bar），右侧放一个 `<>` 图标按钮：点它就在
 * 「树（逐层折叠的结构视图）」和「原文（完整文本，可整体复制）」之间切换。
 * 为什么两态都要：树适合「找字段」，原文适合「看字节 / 整段复制」。单给树，用户拿不到
 * 可复制的整体；单给原文，深层结构没法看。默认树。
 *
 * 当前处于哪一态**只由那个 `<>` 按钮表达**（选中即实心高亮）：早先还在左边挂了个
 * 「树 / 原文」徽标，与按钮说的是同一件事，纯冗余（用户点名去掉）。
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
            notificationStore.addToast(
                "success",
                "已复制到剪贴板",
                copyOkMeta({ what: "JSON 原文", text: text(), mech: "JsonViewer.tsx::copy" }),
            );
        } catch (e) {
            notificationStore.addToast(
                "error",
                "复制失败（剪贴板不可用）",
                copyFailMeta({ what: "JSON 原文", mech: "JsonViewer.tsx::copy", error: e }),
            );
        }
    };
    return (
        <div class="flex flex-col h-full min-h-0">
            {/* 查看栏：右侧 `<>` 切树/原文，旁边是复制 */}
            <div class="flex items-center gap-1 shrink-0 pb-1 border-b border-base-300 mb-1">
                <div class="ml-auto" />
                <button
                    class={`btn btn-xs font-mono ${raw() ? "btn-primary" : "btn-ghost"}`}
                    aria-pressed={raw()}
                    title={raw() ? "当前：原文 —— 点击切到「树」" : "当前：树 —— 点击切到「原文」"}
                    onClick={() => setRaw((v) => !v)}
                >
                    {"<>"}
                </button>
                <button class="btn btn-xs btn-ghost" onClick={copy}>
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
