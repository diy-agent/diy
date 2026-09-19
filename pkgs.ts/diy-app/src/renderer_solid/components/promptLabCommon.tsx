// components/promptLabCommon.ts — 试验场页面共享（V4 用，V1~V3 不动）
// 行级 diff + 即时悬浮提示；**类型一律从 shared/prompt-schema 取**（曾经手抄一份 PromptEntry，必然会漂移）。
import { createSignal, Show } from "solid-js";

export type { PromptEntry, RequestPreview } from "../../shared/prompt-schema";

/** 即时悬浮提示（viewport fixed）：daisyUI tooltip 在 overflow-auto 窗格里会被裁掉，
 * 原生 title 又有 OS 级延迟；这个悬停即显、永不裁剪，样式与 daisyUI tooltip 一致。
 * 用法：const hov = useHoverTip(); {hov.node()} 放页面根；目标 onMouseOver={(e)=>hov.show(text,e)} onMouseLeave={hov.hide} */
export function useHoverTip() {
    const [tip, setTip] = createSignal<{ text: string; x: number; y: number } | null>(null);
    const show = (text: string, e: MouseEvent) => {
        if (!text) return;
        setTip({
            text,
            x: Math.min(e.clientX + 14, window.innerWidth - 260),
            y: Math.min(e.clientY + 16, window.innerHeight - 80),
        });
    };
    const hide = () => setTip(null);
    const node = () => (
        <Show when={tip()}>
            {(t) => (
                <div
                    class="pointer-events-none fixed z-[100] max-w-64 rounded bg-neutral px-2 py-1 text-xs leading-relaxed text-neutral-content shadow-lg"
                    style={{ left: `${t().x}px`, top: `${t().y}px` }}
                >
                    {t().text}
                </div>
            )}
        </Show>
    );
    return { show, hide, node };
}

// diff 实现移入 shared/line-diff.ts（纯模块，可在 node 里跑基准）；这里保持原导出名不变
export { lineDiff, type DiffLine } from "../../shared/line-diff";
