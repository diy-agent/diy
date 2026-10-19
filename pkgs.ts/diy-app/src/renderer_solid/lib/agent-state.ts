// lib/agent-state.ts — 「任务在 agent 面上什么状态」的**组合器**（renderer 侧）：
// 把三处真源喂进 shared/task-agent-state 的纯判据。渲染组件只调本函数，不各自拼判据。
//
// 数据源（逐项指名，禁止猜测；判据本身在 shared/task-agent-state.ts 头注）：
//   · inTurn / unread ← store/sessionStore（全局唯一的会话注册表订阅 + 已读水位 + 账本，##308）；
//     **未读的单位是轮次（1 轮 = 1 条消息）**，读口是 `unreadTurnsOf`（尺子 = max(注册表, 账本)）
//   · hasDraft        ← store/draftStore（权威在任务目录 .diy/drafts.yaml；本 store 是内存镜像）
//                       兜底用调用方给的**落盘快照**（任务树 / 任务详情载荷）
//   · hasSession      ← 调用方给的落盘快照（任务树 / 任务详情载荷的 `has_session`，
//                       main 侧 local-paths.hasConversation 算的）
import { sessionStore } from "../store/sessionStore";
import { draftStore } from "../store/draftStore";
import { taskAgentStateOf, type TaskAgentStateView } from "../../shared/task-agent-state";

/** 渲染端能拿到的落盘快照（任务树行 / 任务详情二选一，字段同义） */
export interface AgentStateFallback {
    hasSession?: boolean;
    hasDraft?: boolean;
}

/**
 * 组出该任务的 agent 面状态。
 *
 * ⚠️ 「落盘快照」是**兜底**不是主源：草稿快照来自任务树/任务详情那一次 RPC，清空草稿后它要等
 * 下一次 reload 才更新 —— 若拿它压过 draftStore 的活值，用户清掉草稿后会看到"有草稿"这种假事实。
 * 故 **draftStore 灌入过该任务就以它为准**（isSeeded 是判据）。
 *
 * ⚠️ 反向的坑同样存在：`hasSession` **不能**用"注册表里有没有条目"推 —— 打开会话页就会建条目
 * （ops 订阅者变化 → noteActivity），"打开过" ≠ "说过话"。故只认落盘快照。
 */
export function agentStateOf(uri: string, fallback: AgentStateFallback = {}): TaskAgentStateView {
    const e = sessionStore.byUri(uri);
    const hasDraft = draftStore.isSeeded(uri)
        ? draftStore.hasAny(uri, ["agent_input"])
        : fallback.hasDraft === true;
    return taskAgentStateOf({
        inTurn: e?.turn != null,
        unreadTurns: sessionStore.unreadTurnsOf(uri),
        hasDraft,
        hasSession: fallback.hasSession === true,
    });
}
