// components/promptLabCommon.ts — 试验场页面共享（V4 用，V1~V3 不动）
// 同一套 template.* RPC 的前端类型 + 行级 diff + 分组映射 + 即时悬浮提示。
import { createSignal, Show } from "solid-js";

export interface PromptEntry {
    relpath: string;
    title: string;
    desc: string;
    version: number;
    overridable: boolean;
    tip: string;
    status: "builtin" | "overridden";
    current: string;
    builtin: string;
    baseVersion: number | null;
    stale: boolean;
}

export interface RequestPreview {
    system: string;
    unknownVars: string[];
    /** 非空即超出系统上下文预算：拒绝发送（不做自动截断） */
    overBudget: { used: number; budget: number } | null;
    /** 仿真请求体（request.json 同形，有任务场景时才有） */
    requestBody?: Record<string, unknown> | null;
    requestNote?: string;
}

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

/** 朴素行级 diff（LCS）：[{t:' '|'-'|'+', s}]，模版小文本够用 */
export function lineDiff(a: string, b: string): Array<{ t: string; s: string }> {
    const A = a.split("\n");
    const B = b.split("\n");
    const n = A.length;
    const m = B.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i]![j] = A[i] === B[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    const out: Array<{ t: string; s: string }> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) {
            out.push({ t: " ", s: A[i]! });
            i++;
            j++;
        } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
            out.push({ t: "-", s: A[i]! });
            i++;
        } else {
            out.push({ t: "+", s: B[j]! });
            j++;
        }
    }
    while (i < n) out.push({ t: "-", s: A[i++]! });
    while (j < m) out.push({ t: "+", s: B[j++]! });
    return out;
}
