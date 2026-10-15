// components/SessionChip.tsx — 会话状态的**行内标记**（nav 标签 / 任务表行共用，##308）。
//
// 为什么是一个组件而不是两处各写一段：判据在 shared/session-overview（纯函数），渲染只负责画 ——
// nav 上写一份、任务表里再写一份，"同一个会话两处显示不同状态"就只是时间问题。
// 数据不从这里订阅：全局唯一订阅在 store/sessionStore（R3：多一处订阅就多一份漂移源）。
import { Show } from "solid-js";
import { sessionStore } from "../store/sessionStore";
import type { SessionChipView } from "../../shared/session-overview";

const TONE_BADGE: Record<SessionChipView["tone"], string> = {
    primary: "badge-primary",
    warning: "badge-warning",
    error: "badge-error",
    ghost: "badge-ghost",
};

const TONE_DOT: Record<SessionChipView["tone"], string> = {
    primary: "bg-primary",
    warning: "bg-warning",
    error: "bg-error",
    ghost: "bg-base-content/40",
};

/** 完整 chip（图标 + 一行文案）：展开态 nav 与任务表行用 */
export function SessionChip(props: { uri: string; class?: string }) {
    const chip = () => sessionStore.chipOf(props.uri);
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
    const chip = () => sessionStore.chipOf(props.uri);
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
