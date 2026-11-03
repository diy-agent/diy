// components/SessionGlyph.tsx — **会话状态的唯一图标实现**（##393）。
//
// 四个面（nav 会话行 / 任务表行 / 任务详情 + 任务树 / 总览表格）都用它，因此「同一个会话在四处
// 显示不同状态」不再是"靠自觉"，而是**结构上不可能**：判据只有 `lib/session-state`，图标只有这里。
//
// 【图标语言（用户 2026-10-20 拍板）】
//   形状 = 阶段（色弱用户靠它）：空心圆 = 未运行 · 实心圆 + 光环 = 运行中 · UML 终态圆 = 已结束。
//   线型 = 待处理等级：实线（已定型）/ 虚线（`unknown`，等你裁定）/ 双环（`defect`，我方缺陷）。
//   颜色 = 归因（唯一表在 `shared/session-state::TONE_OF_BLAME`）。
//   动画 = 还在动（停滞时光环变慢 —— 那是**运行健康度**，不是第四种状态）。
//   文字只进 tooltip（用户 3.1：「有未读」文字 badge 与 `+N` 重复，删）。
//
// 为什么不用 `ChatGlyph` 那套：那是「聊过没有」的二值暗示（暗/亮会话气泡），
// 而这里要表达的是三态 + 归因 + 未读/草稿/排队，一个气泡装不下。
import { Show } from "solid-js";
import { sessionGlyphFor, type SessionStateFallback } from "../lib/session-state";
import type { GlyphTone } from "../../shared/session-state";

/** 归因 → 颜色 class（**唯一配色落点**；色值在 index.css 的 `--color-diy-end-*`） */
export const TONE_TEXT: Record<GlyphTone, string> = {
    muted: "text-base-content/40",
    ok: "text-diy-end-normal",
    green: "text-success",
    slate: "text-diy-end-user",
    amber: "text-diy-end-limit",
    orange: "text-diy-end-service",
    teal: "text-diy-end-env",
    violet: "text-diy-end-unknown",
    red: "text-error",
};

const SIZE_PX: Record<"xs" | "sm" | "md", number> = { xs: 10, sm: 12, md: 14 };

export interface SessionGlyphProps extends SessionStateFallback {
    uri: string;
    /** 尺寸：xs = 表格行内 · sm = nav 行 · md = 详情面板 */
    size?: "xs" | "sm" | "md";
    /** 未读数字 / 草稿 / 排队角标（默认开；详情面板分列展示时可关） */
    withMarks?: boolean;
    class?: string;
}

/**
 * 会话状态图标（唯一实现）。
 *
 * `data-session-*` 是**一致性断言的锚点**：四个面渲染出的这三个值必须相同，
 * 测试直接比属性，不靠截图（见 `tests/core/session-state.test.ts` 的「同源」用例）。
 */
export function SessionGlyph(props: SessionGlyphProps) {
    const g = () => sessionGlyphFor(props.uri, { hasSession: props.hasSession, hasDraft: props.hasDraft });
    const px = () => SIZE_PX[props.size ?? "sm"];
    return (
        <Show when={g()}>
            {(v) => (
                <span
                    class={`inline-flex items-center gap-0.5 shrink-0 align-middle ${TONE_TEXT[v().tone]} ${props.class ?? ""}`}
                    title={v().tip}
                    data-session-glyph={props.uri}
                    data-session-state={v().shape === "live" ? "running" : v().shape === "ended" ? "ended" : "never"}
                    data-session-end={v().label}
                    data-session-blame={v().tone}
                    data-session-stalled={v().motion === "slow" ? "1" : "0"}
                    data-session-unread={v().count ? v().count.slice(1) : "0"}
                >
                    <Show
                        when={v().shape === "live"}
                        fallback={
                            <Show
                                when={v().shape === "ended"}
                                fallback={
                                    /* 未运行：空心圆（细）—— 「没开始」与「结束了」形状上就不同 */
                                    <svg width={px()} height={px()} viewBox="0 0 16 16" aria-hidden="true">
                                        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" />
                                    </svg>
                                }
                            >
                                {/* 已结束：UML 终态圆（外圈 + 实心内点）；线型在 svg 里表达 */}
                                <svg width={px()} height={px()} viewBox="0 0 16 16" aria-hidden="true">
                                    <Show when={v().line === "double"}>
                                        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1" />
                                    </Show>
                                    <circle
                                        cx="8"
                                        cy="8"
                                        r={v().line === "double" ? 5 : 6.4}
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.4"
                                        stroke-dasharray={v().line === "dashed" ? "2.6 2.2" : undefined}
                                    />
                                    <circle cx="8" cy="8" r="3" fill="currentColor" />
                                </svg>
                            </Show>
                        }
                    >
                        {/* 运行中：实心圆 + 外扩光环（nav 一直用的 `aura`；停滞时光环变慢） */}
                        <span
                            class={`aura aura-dual text-success ${v().motion === "slow" ? "opacity-70" : ""}`}
                            style={v().motion === "slow" ? { "animation-duration": "6s" } : undefined}
                        >
                            <span class={`status status-success ${v().motion === "slow" ? "" : "animate-pulse"}`} />
                        </span>
                    </Show>
                    <Show when={props.withMarks !== false && v().count}>
                        <span class="font-mono text-caption">{v().count}</span>
                    </Show>
                    <Show when={props.withMarks !== false && v().draftMark}>
                        <span class="text-caption text-warning" title="有未发送草稿">
                            {v().draftMark}
                        </span>
                    </Show>
                    <Show when={props.withMarks !== false && v().queueMark}>
                        <span class="font-mono text-caption text-diy-queue" title="留言待投递">
                            {v().queueMark}
                        </span>
                    </Show>
                </span>
            )}
        </Show>
    );
}

/** 收缩态（40px rail）要的只是那个"点"：同一个判据、同一个颜色，不带任何角标 */
export function SessionGlyphDot(props: SessionGlyphProps) {
    const g = () => sessionGlyphFor(props.uri, { hasSession: props.hasSession, hasDraft: props.hasDraft });
    return (
        <Show when={g()}>
            {(v) => (
                <span
                    class={`inline-flex shrink-0 ${TONE_TEXT[v().tone]} ${props.class ?? ""}`}
                    title={v().tip}
                    data-session-glyph={props.uri}
                    data-session-state={v().shape === "live" ? "running" : v().shape === "ended" ? "ended" : "never"}
                    data-session-end={v().label}
                    data-session-blame={v().tone}
                >
                    <Show
                        when={v().shape === "live"}
                        fallback={<span class="w-1.5 h-1.5 rounded-full bg-current inline-block" />}
                    >
                        <span class="aura aura-dual text-success">
                            <span class="status status-success animate-pulse" />
                        </span>
                    </Show>
                </span>
            )}
        </Show>
    );
}
