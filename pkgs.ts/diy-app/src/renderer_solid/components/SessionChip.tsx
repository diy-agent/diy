// components/SessionChip.tsx — 会话状态的**行内标记**（nav 标签 / 任务表行共用，##308）。
//
// 为什么是一个组件而不是两处各写一段：判据在 shared/session-overview（纯函数），渲染只负责画 ——
// nav 上写一份、任务表里再写一份，"同一个会话两处显示不同状态"就只是时间问题。
// 数据不从这里订阅：全局唯一订阅在 store/sessionStore（R3：多一处订阅就多一份漂移源）。
// 判据的**合成**在 lib/session-mark（注册表 chip × 账本「已对话」，##358）；本文件只管画。
import { Show, createEffect } from "solid-js";
import { sessionMarkOf } from "../lib/session-mark";
import { usageLedgerStore } from "../store/usageLedgerStore";
import type { SessionChipView } from "../../shared/session-overview";

/**
 * tone → daisyUI badge 色（**按颜色说话**，用户 2026-10-16 给的就是颜色词）：
 *   绿 = 未读 / 运行中 · 黄 = 停滞 / 留言 · 红 = 未读且异常终止 · 灰 = 已对话（弱标）。
 *
 * ⚠️ `primary` 落的是 **`badge-success`（绿）**，不是 `badge-primary` —— 本主题的 primary 是蓝紫，
 * 与"绿色是未读"的口径不符。三处（nav / 任务表 / 总览）同走本表，改色只有这一处。
 */
export const TONE_BADGE: Record<SessionChipView["tone"], string> = {
    primary: "badge-success",
    warning: "badge-warning",
    error: "badge-error",
    ghost: "badge-ghost",
};

const TONE_DOT: Record<SessionChipView["tone"], string> = {
    primary: "bg-success",
    warning: "bg-warning",
    error: "bg-error",
    ghost: "bg-base-content/40",
};

/** 完整 chip（图标 + 一行文案）：展开态 nav 与任务表行用 */
export function SessionChip(props: { uri: string; class?: string }) {
    // 谁渲染谁驱动：标记要看的账本事实由**这里**发起拉取（幂等、有缓存与并发上限）。
    // 放组件里而不是全局 effect：只拉真正出现在界面上的任务，表几百行也不会开机就爆。
    createEffect(() => usageLedgerStore.ensure(props.uri));
    const chip = () => sessionMarkOf(props.uri);
    return (
        <Show when={chip()}>
            {(c) => (
                <span
                    class={`badge badge-xs gap-0.5 font-normal whitespace-nowrap align-middle ${TONE_BADGE[c().tone]} ${props.class ?? ""}`}
                    title={c().tip}
                    data-session-chip={props.uri}
                >
                    <span>{c().icon}</span>
                    <span>{c().text}</span>
                </span>
            )}
        </Show>
    );
}

/**
 * 收缩态（40px rail）装不下文案 → 退成一个**状态点**（颜色即语义，`title` 给全文）。
 *
 * 不省掉它是刻意的：rail 是"常驻可见"的那一态，任务栏里最该一眼看到的正是"有条会话在烧"。
 */
export function SessionDot(props: { uri: string; class?: string }) {
    createEffect(() => usageLedgerStore.ensure(props.uri));
    const chip = () => sessionMarkOf(props.uri);
    return (
        <Show when={chip()}>
            {(c) => (
                <span
                    class={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[c().tone]} ${props.class ?? ""}`}
                    title={c().tip}
                    data-session-dot={props.uri}
                />
            )}
        </Show>
    );
}
