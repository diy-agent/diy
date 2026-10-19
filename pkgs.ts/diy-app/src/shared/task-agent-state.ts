/**
 * task-agent-state.ts — 「任务在 agent 面上现在是什么状态」的呈现判据（纯函数，renderer 与单测共用）。
 *
 * 四态（##355 / 归口 ##191，用户 2026-10-15 口述批次）：
 *   · `in-turn` —— 正在一轮活动对话中
 *   · `unread`  —— 对话已停止，但自上次查看以来有**未读**新信息
 *   · `draft`   —— 有**未发送的**输入（草稿）
 *   · `clean`   —— 从未与 agent 对话过（干净任务）
 * 外加 `idle`（有历史、已读、无草稿）—— 它**不是**用户点名的四态，是判据的**兜底残余**：
 * 没有它，「有历史但无事」会被误判成「干净」，那是假事实（见 `hasSession` 的注释）。
 *
 * 【优先级（互斥化）】in-turn > unread > draft > clean > idle。四态在 UI 上是**单轴**的
 * 一句话，不并排罗列（并排会让"正在跑"与"有草稿"同时出现，用户无从下手）。
 * 排序依据 = 「此刻最该被看见的事」：在跑（正在动）＞有未读（你没看到的新产出）＞
 * 有草稿（你自己的未完成输入）＞未对话（没动过）＞空闲（无事）。
 *
 * 【为什么是纯函数】三处消费者（nav 项 / 任务表行 / 任务属性面板）必须**同一套判据**，
 * 否则「同一个任务在 nav 说在跑、在任务表说未对话」这类分叉必然发生（与 ##308 同一条理由）。
 * 渲染只负责画。
 *
 * 【数据源（禁止 UI 猜测；每个输入都指名真源）】
 *   · `inTurn`      ← `SessionEntry.turn != null`（`agent.local.sessions`，main 内存权威，
 *                      见 main/services/session-registry.ts 的 noteTurnStart/noteTurnEnd）
 *   · `unreadTurns` ← `max(注册表 turnCount, 账本轮次) − renderer 已读水位`（##358 口径订正：
 *                      单位是**轮次**，1 轮 = 1 条未读消息；读口 sessionStore.unreadTurnsOf）
 *   · `hasDraft`    ← 任务目录 `.diy/drafts.yaml` 的 `agent_input` 字段（未提交的输入；
 *                      main 侧 core/drafts.ts 的 DRAFT_FIELDS）
 *   · `hasSession`  ← 该任务的会话 **Op 日志是否存在且非空**（main/core/local-paths.ts
 *                      的 opsFile；`clear` 会删它 ⇒ 存在即"对话过"）
 */

/** 四种点名态 + 兜底残余（见头注：idle 不是四态之一） */
export type TaskAgentStateKind = "in-turn" | "unread" | "draft" | "clean" | "idle";

export interface TaskAgentStateInput {
    /** 此刻有轮次在跑（main 内存真值） */
    inTurn: boolean;
    /** 自上次查看以来的新增轮次（0 = 已读；1 轮 = 1 条消息） */
    unreadTurns: number;
    /** 有未发送的草稿（agent 输入框） */
    hasDraft: boolean;
    /** 这个任务**有过**对话（会话日志非空）—— 「干净任务」的判据 */
    hasSession: boolean;
}

export interface TaskAgentStateView {
    kind: TaskAgentStateKind;
    /** 短标签（行内 chip 用）；行内 chip 对 `idle` 不渲染（`agentStateActive` 是判据） */
    label: string;
    icon: string;
    /** daisyUI 语义色（badge-<tone>） */
    tone: "primary" | "warning" | "info" | "ghost";
    /** tooltip：把判据与数据源一次说全 */
    tip: string;
}

/**
 * 单轴判据（优先级见头注）。
 *
 * ⚠️ `unreadTurns <= 0` 一律不算未读 —— 负数（水位比当前轮次还大，如刚清空会话）也必须落到
 * 后面的分支，不许出现"−3 条未读"这种荒谬显示。
 */
export function taskAgentStateOf(i: TaskAgentStateInput): TaskAgentStateView {
    if (i.inTurn) {
        return {
            kind: "in-turn",
            label: "对话中",
            icon: "●",
            tone: "primary",
            tip: "正在一轮对话中（main 内存真值：会话注册表该任务 turn 非空）",
        };
    }
    if (i.unreadTurns > 0) {
        return {
            kind: "unread",
            label: "有未读",
            icon: "◎",
            tone: "info",
            tip: `对话已停止，但有 ${i.unreadTurns} 条是你上次查看之后新跑的（会话总轮次 − 你的已读水位；1 轮 = 1 条）`,
        };
    }
    if (i.hasDraft) {
        return {
            kind: "draft",
            label: "有草稿",
            icon: "✎",
            tone: "warning",
            tip: "输入框里有未发送的草稿（真源：任务目录 .diy/drafts.yaml 的 agent_input）",
        };
    }
    if (!i.hasSession) {
        return {
            kind: "clean",
            label: "未对话",
            icon: "○",
            tone: "ghost",
            tip: "这个任务从未与 agent 对话过（真源：该任务的会话 Op 日志不存在或为空）",
        };
    }
    return { kind: "idle", label: "空闲", icon: "·", tone: "ghost", tip: "会话空闲：无未读、无草稿" };
}

/** 该态是否"有事"（`idle` = 没事）—— 行内 chip 据此决定渲不渲染（##308 同一取向） */
export function agentStateActive(v: TaskAgentStateView): boolean {
    return v.kind !== "idle";
}

// ─── 窗口占用（合作者：##339 的阈值口径 / ##262 的用量 UI） ───────────────

/** 窗口占用视图（token 数与阈值都是**实测/配置的真值**，一个不编） */
export interface WindowUsageView {
    /** 该会话**最后一步实测**窗口占用（token 数） */
    tokens: number;
    /** 触发压缩的窗口阈值（token 数；##339 拍板 = 固定数字，进 token 域） */
    limit: number;
    /** 0..1；limit <= 0（关闭该触发）→ null（不编百分比） */
    pct: number | null;
    /** 展示文本，如 `12.3k / 38.4k（32%）` */
    text: string;
    /** ok（<80%）/ warn（≥80%）/ over（≥100%：撞阈值，按配置该压了） */
    tone: "ok" | "warn" | "over";
    tip: string;
}

/** warn 门槛：距阈值还剩不到两成时先出声（不是"到阈值才算"，那已经晚了） */
export const WINDOW_WARN_RATIO = 0.8;

/**
 * 窗口占用 → 展示视图。
 *
 * ⚠️ **没有实测就不画**（`tokens === null` → null）：老会话 / 手工造的会话没有用量账，
 * 那时编一个 0% 出来比不显示更坏（用户会以为"窗口是空的"）。阈值同理（limit<=0 = 关闭触发）。
 */
export function windowUsageOf(
    tokens: number | null | undefined,
    limit: number | null | undefined,
    fmt: (n: number) => string = String,
): WindowUsageView | null {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return null;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
    const pct = tokens / limit;
    const tone: WindowUsageView["tone"] = pct >= 1 ? "over" : pct >= WINDOW_WARN_RATIO ? "warn" : "ok";
    return {
        tokens,
        limit,
        pct,
        text: `${fmt(tokens)} / ${fmt(limit)}（${Math.round(pct * 100)}%）`,
        tone,
        tip:
            `当前对话窗口占用 ${fmt(tokens)} token，触发压缩的阈值 ${fmt(limit)} token（##339 口径：` +
            `该会话最后一步实测用量 usage.total ≥ 阈值即压）。` +
            (tone === "over" ? "已到阈值：按配置该压缩了。" : tone === "warn" ? "接近阈值。" : ""),
    };
}
