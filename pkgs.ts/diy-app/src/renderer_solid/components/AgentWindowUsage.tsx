// components/AgentWindowUsage.tsx — 会话**窗口占用**那一行（##339 阈值口径 / ##262 用量 UI）。
//
// 原属 TaskAgentState.tsx（##355）。##393 把那个文件的「任务四态单轴」判据删掉后，
// 只剩这块与状态无关的用量视图 ⇒ 单独成文件（文件名单一职责，别再往这里塞状态判据：
// 状态判据唯一真源 = shared/session-state.ts，图标唯一实现 = components/SessionGlyph.tsx）。
import { createResource, Show } from "solid-js";
import { windowUsageOf } from "../../shared/task-agent-state";
import { triggerTokensOf } from "@diy/compaction/select-kept-boundary";
import { fmtTokens } from "../../shared/usage";
import { sessionStore } from "../store/sessionStore";
import { localChatStore } from "../store/localChatStore";

/**
 * 窗口占用（token 数 + 占阈值比例）—— 任务属性面板里的「窗口」行内容。
 *
 * 数据源 = `agent.local.autoCompactStatus`（只读）：`facts.windowTokens` = **该会话最后一步实测**
 * 窗口占用（token 数，##339/##211 口径），触发阈值 = 窗口 − max(10%, 16k)（##442 零旋钮）。
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
                facts?: { windowTokens?: number | null; windowLimitTokens?: number | null };
            },
    );
    /** 触发阈值（token）= 窗口 − max(10%, 16k)；窗口未知 ⇒ undefined（不猜数） */
    const threshold = (): number | undefined => {
        const limit = res()?.facts?.windowLimitTokens;
        return typeof limit === "number" && limit > 0 ? triggerTokensOf(limit) : undefined;
    };
    const view = () => windowUsageOf(res()?.facts?.windowTokens ?? null, threshold(), fmtTokens);
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
