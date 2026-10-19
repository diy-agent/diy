// components/TaskAgentState.tsx — 任务「agent 面状态」的行内标记 + 窗口占用行（##355）。
//
// 为什么是组件而不是三处各写一段：判据全在 shared/task-agent-state（纯函数），
// 组合在 lib/agent-state（把注册表 / 草稿 / 落盘快照三处真源喂进去）——
// nav 上写一份、任务表里再写一份，"同一个任务两处显示不同状态"就只是时间问题（同 ##308）。
// 数据订阅仍只有一份（sessionStore / draftStore），本组件不自己订阅任何流。
import { createResource, Show } from "solid-js";
import { agentStateOf } from "../lib/agent-state";
import { agentStateActive, windowUsageOf, type TaskAgentStateView } from "../../shared/task-agent-state";
import { fmtTokens } from "../../shared/usage";
import { sessionStore } from "../store/sessionStore";
import { localChatStore } from "../store/localChatStore";

const TONE_BADGE: Record<TaskAgentStateView["tone"], string> = {
    primary: "badge-primary",
    warning: "badge-warning",
    info: "badge-info",
    ghost: "badge-ghost opacity-70",
};

const TONE_DOT: Record<TaskAgentStateView["tone"], string> = {
    primary: "bg-primary",
    warning: "bg-warning",
    info: "bg-info",
    ghost: "bg-base-content/40",
};

/** 落盘快照（任务树行 / 任务详情载荷的 has_session / has_draft，见 lib/agent-state 头注） */
export interface TaskAgentStateProps {
    uri: string;
    hasSession?: boolean;
    hasDraft?: boolean;
    class?: string;
}

/**
 * 行内 chip（图标 + 标签）：任务表行 / nav 展开态用。
 * `idle` 不渲染 —— 几百行都挂个"空闲"等于噪音（与 ##308 chip 同取向）；
 * 要看"空闲"这个**明确结论**的地方用 `always`（任务属性面板那种单任务视图）。
 */
export function TaskAgentStateBadge(props: TaskAgentStateProps & { always?: boolean }) {
    const st = () => agentStateOf(props.uri, { hasSession: props.hasSession, hasDraft: props.hasDraft });
    return (
        <Show when={props.always || agentStateActive(st())}>
            <span
                class={`badge badge-xs gap-0.5 font-normal whitespace-nowrap align-middle ${TONE_BADGE[st().tone]} ${props.class ?? ""}`}
                title={st().tip}
                data-task-agent-state={st().kind}
                data-task-agent-uri={props.uri}
            >
                <span>{st().icon}</span>
                <span>{st().label}</span>
            </span>
        </Show>
    );
}

/** 收缩态（40px rail）装不下文案 → 退成一个状态点（颜色即语义，title 给全文） */
export function TaskAgentStateDot(props: TaskAgentStateProps) {
    const st = () => agentStateOf(props.uri, { hasSession: props.hasSession, hasDraft: props.hasDraft });
    return (
        <Show when={agentStateActive(st())}>
            <span
                class={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[st().tone]} ${props.class ?? ""}`}
                title={st().tip}
                data-task-agent-dot={props.uri}
                data-task-agent-state={st().kind}
            />
        </Show>
    );
}

/**
 * 窗口占用（token 数 + 占阈值比例）—— 任务属性面板里的「窗口」行内容。
 *
 * 数据源 = `agent.local.autoCompactStatus`（只读）：`facts.windowTokens` = **该会话最后一步实测**
 * 窗口占用（token 数，##339/##211 口径），`config.triggers.contextWindowOver` = 触发压缩的阈值。
 * 两个都是真值，一个不编；拿不到就显示 `—`（老会话没有用量账，编个 0% 比不显示更坏）。
 *
 * 刷新时机 = 该任务**轮次有进展**时重取（resource 的 key 带 `totalSteps` + 在跑步数）：
 * 用量账是**轮末/步末**才落的，靠 uri 变化刷新会一直停在开面板那一刻。
 */
export function AgentWindowUsage(props: { uri: string }) {
    const [res] = createResource(
        () => {
            const e = sessionStore.byUri(props.uri);
            return `${props.uri}#${e?.totalSteps ?? 0}#${e?.turn?.steps ?? 0}`;
        },
        async () =>
            (await localChatStore.autoCompactStatus(props.uri)) as {
                facts?: { windowTokens?: number | null };
                config?: { triggers?: { contextWindowOver?: number } };
            },
    );
    const view = () =>
        windowUsageOf(
            res()?.facts?.windowTokens ?? null,
            res()?.config?.triggers?.contextWindowOver,
            fmtTokens,
        );
    return (
        <Show
            when={view()}
            fallback={
                <span class="min-w-0 truncate opacity-50" title="这个会话还没有实测用量（跑过一轮才会有）；不编造数字">
                    —
                </span>
            }
        >
            {(v) => (
                <span class="flex min-w-0 items-center gap-1.5" title={v().tip} data-window-usage={props.uri}>
                    <span
                        class={`progress progress-${v().tone === "over" ? "error" : v().tone === "warn" ? "warning" : "primary"} h-1.5 w-16 shrink-0`}
                    >
                        <span
                            class="progress-bar"
                            style={{ width: `${Math.min(100, Math.round((v().pct ?? 0) * 100))}%` }}
                        />
                    </span>
                    <span class="min-w-0 truncate font-mono text-body">{v().text}</span>
                </span>
            )}
        </Show>
    );
}
