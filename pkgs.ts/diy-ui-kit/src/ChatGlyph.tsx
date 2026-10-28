// components/ChatGlyph.tsx — 「这个任务有没有聊过」的**图标形态**（##358，用户 2026-10-19）。
//
// 用户原话：「nav 上『已对话』改成状态图标，会话聊天的图标暗色和亮色暗示对话状态」。
// ⇒ 文字标记（`○ 未对话` / `◌ 已对话`）在 nav 这种窄地方太占位，而且两个词要用两套判据去解释；
// 一个**会话气泡**的明暗就够了：**淡 = 从未聊过**、**稍亮 = 聊过（没有新消息）**。
//
// 为什么单独一个文件而不是在两个组件里各画一份 svg：nav 上的「未对话」来自 task-agent-state、
// 「已对话」来自 session-mark —— 两处给不同形状/不同明暗，"聊没聊过"就又成了两套视觉语言。
// 有**新消息/在跑**时不走这里：那是彩色 badge 的活（`+N` / `●`），这里只表达"静默的对话史"。
import { Show } from "solid-js";

/** 明暗两档：`never` = 从未对话 · `talked` = 已对话（无新消息） */
export type ChatGlyphTone = "never" | "talked";

const OPACITY: Record<ChatGlyphTone, string> = {
    // 0.25 在深色/浅色主题下都还看得见，但明显"不主张"；0.55 是"确实有事发生过"
    never: "opacity-25",
    talked: "opacity-55",
};

export function ChatGlyph(props: { tone: ChatGlyphTone; tip: string; class?: string }) {
    return (
        <span
            class={`inline-flex shrink-0 ${OPACITY[props.tone]} ${props.class ?? ""}`}
            title={props.tip}
            data-chat-glyph={props.tone}
            aria-label={props.tone === "talked" ? "已对话" : "未对话"}
        >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <Show when={props.tone === "talked"} fallback={
                    /* 从未对话：空心气泡（轮廓 = "这里可以开始"，但还没开始） */
                    <path
                        d="M2.8 2.2h10.4c.9 0 1.6.7 1.6 1.6v7.1c0 .9-.7 1.6-1.6 1.6H7.2l-3.5 2.5c-.4.3-.9 0-.9-.5V3.8c0-.9.7-1.6 1.6-1.6zm.7 1.6v9.1l2.9-2.1h6.8c.1 0 .2-.1.2-.2V3.8c0-.1-.1-.2-.2-.2H3.5c-.1 0-.2.1-.2.2z"
                        fill-rule="evenodd"
                    />
                }>
                    /* 已对话：实心气泡（聊过 = 有内容） */
                    <path d="M2.8 2.2h10.4c.9 0 1.6.7 1.6 1.6v7.1c0 .9-.7 1.6-1.6 1.6H7.2l-3.5 2.5c-.4.3-.9 0-.9-.5V3.8c0-.9.7-1.6 1.6-1.6z" />
                </Show>
            </svg>
        </span>
    );
}
