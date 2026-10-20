/**
 * session-state.ts — **会话状态的唯一判据**（##393，纯函数，零 UI，main / renderer / 单测共用）。
 *
 * 【为什么有这一层（病根）】
 *   改造前「这个会话现在怎么样」被四份判据各拼一遍：
 *     · `shared/task-agent-state.ts` —— 四态**单轴互斥** `in-turn > unread > draft > clean > idle`，
 *       把「有未读」（属性）当成了运行状态，于是同一行里 `有未读` 与 `+3` 说了两遍（用户 3.1）；
 *     · `shared/session-nav.ts` —— nav 主角标优先级里又混了「停滞 / 未读 / 队列」三种不同性质的东西；
 *     · `shared/session-overview.ts` —— 总览页自己一套 `abnormalEndOf`；
 *     · 渲染层 `SessionChip.tsx` / `TaskAgentState.tsx` 各有一张配色表。
 *   四份只差时间就会漂 ⇒ 用户 3.3 的「四处显示不一致」是必然，不是偶然。
 *
 * 【模型（用户 2026-10-20 拍板，v4）】
 *   ① **运行状态只有三个值**：`never`（未运行 / 从未对话）· `running`（运行中）· `ended`（已结束）。
 *   ② **结束原因不是状态，是属性**（`end` / `blame`）：`ended` 之下不再分「正常 / 异常 / 被终止」这种
 *      二次分类 —— 用户原话：「分类这个东西很难达成一致的，就干脆直接放**根因**就行了」。
 *      根因照抄 `TurnEndReason`（`main/services/local-blocks.ts`，**不改值域**），只在旁边挂一个
 *      `blame` 回答「这事该谁管、要不要紧张」。
 *   ③ **草稿属于 `never`**（用户：草稿当然属于未开始对话）；**排队属于 `running`**
 *      （用户：只有正在运行的对话才会出现排队现象）。二者是属性，不是状态。
 *   ④ **停滞是 `running` 的健康度属性**，不另开状态（用户：「停滞不用说就是运行中，只是卡住了」）。
 *   ⑤ **未读是纯属性**，与运行状态正交（用户 3.4：「未读是个属性」）。
 *      **类型上钉死**：属性轴单独一个 `SessionFlags`（见下），`RunState` 里**永远**不会出现
 *      「未读 / 草稿 / 队列 / 停滞」这类值 —— 要读属性就调 `flagsOf(state)`，别去读状态轴。
 *      （##395 的 `visitedAt` / `dismissedTurns` / `mute` 也只往 `SessionFlags` 长，不动 `RunState`。）
 *   ⑥ `lastEndReason == null` 的**遗留**记录（早于 endReason 的历史数据）不做归因、不提示 ——
 *      用户：「属于遗留问题，无法分析，所以不管了」。它照常显示「已结束 · 正常」。
 *
 * 【图标语言（形状 ⊥ 归因，不能只靠色 —— 色弱兜底）】
 *   形状 = 阶段：`hollow`（空心圆）/ `live`（实心圆 + 光环）/ `ended`（UML 终态：圆圈套实心）。
 *   线型 = 待处理等级：`solid`（已定型）/ `dashed`（`unknown`，等你裁定）/ `double`（`defect`，我方缺陷）。
 *   颜色 = 归因：见 `TONE_OF_BLAME`。
 *   动画 = 还在动：`live`（正常呼吸）/ `slow`（停滞，慢下来）/ `none`。
 *   文案 = 根因（人话走 `shared/turn-end.ts`，**那里是唯一文案源，本文件不另写一套**）。
 *
 * 【`unknown` / `defect` 的来源（一个不编）】
 *   `TurnEndReason` 六个值里**没有**「我方缺陷」信号，也**没有**「已识别的环境问题」信号：
 *     · `defect`   ← 只来自**人为界定的判据**（assert / 不变量破坏 / 死锁检测），走独立信号通道，
 *                    本文件只留位（`Blame` 里有它），今天**恒不产生**；
 *     · `environment` ← 只来自 triage 裁定 / 新埋点，今天**恒不产生**；
 *     · `unknown`  ← 真正来自值域：`aborted:detached`（断流）/ `error:stream` / `interrupted`（崩溃恢复）
 *                    —— 「分不清是网络断、上游断还是被外部 kill」，按用户口径**弹给用户裁定**，不当 bug。
 */

import type { TurnEndReason } from "../main/services/local-blocks";
import type { SessionEntry } from "./registry-frame";
import { abortText, turnEndText } from "./turn-end";

// ─── 模型 ─────────────────────────────────────────────

/** 运行状态（**唯一**的状态轴；用户 2026-10-20 拍板的三值） */
export type RunState = "never" | "running" | "ended";

/**
 * 归因（**不是状态**，是 `ended` 之上的属性）：这件事该谁管。
 *
 * 七值是与 ##394「全局异常体系」的**会话侧投影**——##394 落地后只做映射、不合并：
 *   `defect → defect` · `limit / service / environment → external-recognized` ·
 *   `unknown → external-unknown` · `user / none → expected`
 */
export type Blame = "none" | "user" | "limit" | "service" | "environment" | "unknown" | "defect";

/** ##394 的三档（会话侧只**派生**，不另立真源；`defect` 单独一档） */
export type BlameTier = "expected" | "external-recognized" | "external-unknown" | "defect";

export function tierOf(blame: Blame): BlameTier {
    switch (blame) {
        case "defect":
            return "defect";
        case "unknown":
            return "external-unknown";
        case "limit":
        case "service":
        case "environment":
            return "external-recognized";
        default:
            return "expected"; // none / user
    }
}

/** 根因（**照抄** `TurnEndReason`，只把判别联合摊平成可序列化的形状） */
export interface EndCause {
    type: TurnEndReason["type"];
    /** 仅 aborted / error */
    source?: string;
    /** 仅 error */
    message?: string;
    /** 该轮用户的发言是否真的投送给了模型（`error:budget` = 没投出去；其余未知 ⇒ undefined，不编） */
    delivered?: boolean;
}

/** 会话状态：**一个运行状态 + 一堆正交属性**（属性永远不参与状态判定） */
export interface SessionState {
    /** 唯一状态轴 */
    run: RunState;
    /** 根因（`ended` 且注册表有记录时才有；遗留记录 = null） */
    end: EndCause | null;
    /** 归因（`ended` 之外恒 `none`） */
    blame: Blame;
    /** ##394 三档派生 */
    tier: BlameTier;
    /** 在跑、但心跳超过 `STALL_MS` 没动（**运行中的健康度**，不是状态） */
    stalled: boolean;
    /** 未读消息条数（1 轮 = 1 条；属性） */
    unread: number;
    /** 有未发送草稿（属性；只在 `never` 下谈得上，但字段恒给） */
    draft: boolean;
    /** 待投递留言条数（属性） */
    queued: number;
    /** 水位已追平（没有未读） */
    seen: boolean;
}

/**
 * 会话的**属性轴**（与 `SessionState.run` **正交**；##395「信息组织」的接入口）。
 *
 * 铁律（用户 2026-10-20 拍板）：
 *   · 这里的字段**永远不参与** `run` 的判定，也不构成第四种状态 ——
 *     「有未读」不是「对话中」的兄弟，它是「已结束 + 3 条没看」的**一个属性**。
 *   · 消费者要"有没有未读 / 有没有草稿 / 排了几条"**只准**调 `flagsOf()`，
 *     不许回头去读 `run` 或自己拼（那正是 ##393 之前四份判据各说一半的病根）。
 *   · ##395 新增的 `visitedAt` / `dismissedTurns` / `mute` 落这里，**不新增状态值**。
 */
export interface SessionFlags {
    /** 有未读（= `unreadCount > 0`）。⚠️ 属性，不是状态 */
    unread: boolean;
    /** 未读条数（1 轮 = 1 条，##358 口径） */
    unreadCount: number;
    /** 已读水位已追平（没有未读） */
    seen: boolean;
    /** 有未发送草稿（只在 `never` 下谈得上，但字段恒给） */
    draft: boolean;
    /** 待投递留言条数（##306 插话队列） */
    queued: number;
    /** 在跑但心跳超过 `STALL_MS` 没动 —— **运行健康度**，不是状态 */
    stalled: boolean;
}

/** 从状态里**只取属性轴**（要"未读"就调它；`run` 不参与计算） */
export function flagsOf(s: SessionState): SessionFlags {
    return {
        unread: s.unread > 0,
        unreadCount: s.unread,
        seen: s.seen,
        draft: s.draft,
        queued: s.queued,
        stalled: s.stalled,
    };
}

export interface SessionStateInput {
    /** 注册表条目；`null` = 注册表里没有（重启后的账本独有行） */
    entry: SessionEntry | null;
    /** 该任务**聊过没有**（会话日志 / 账本非空）—— 「从未对话」的判据 */
    hasSession?: boolean;
    /** 跨启动总轮次（注册表 ∪ 账本）；用来判"聊过"的兜底尺子 */
    totalTurns?: number;
    /** 有未发送草稿 */
    hasDraft?: boolean;
    /** 未读条数（调用方按 `newTurnsOf` 算好；本函数不再重复算尺子） */
    unread: number;
    /** 当前时刻（ms）—— 停滞判据要它 */
    now: number;
    /** 停滞阈值覆盖（测试用） */
    stalledMs?: number;
}

// ─── 判据 ─────────────────────────────────────────────

/**
 * `TurnEndReason` → 归因（**唯一一处** switch；§2 的表就是它）。
 *
 * ⚠️ `aborted` 的 `"abort"` 不是"来源不明"——那是**旧版停止按钮**（当时没带 reason，
 * 见 `shared/turn-end.ts:15-19`）⇒ 与 `"user"` 同归 `user`（被终止），不是故障。
 */
export function blameOf(end: TurnEndReason | null | undefined): Blame {
    if (!end) return "none"; // 遗留记录（早于 endReason）/ 未结束
    switch (end.type) {
        case "completed":
            return "none";
        case "max-steps":
        case "max-tokens":
            return "limit";
        case "aborted":
            return end.data.source === "user" || end.data.source === "abort" ? "user" : "unknown";
        case "error":
            switch (end.data.source) {
                case "budget":
                    return "limit"; // 预算用尽：我方限制，且这条根本没投给模型
                case "llm":
                    return "service"; // 上游服务（429 / 401 / model_coming_soon 原文）
                default:
                    return "unknown"; // stream 及未来新增的 source：先当"未识别外部"，不冒充 bug
            }
        case "interrupted":
            return "unknown"; // 崩溃 / 被杀 —— 不预设是我方 bug（可能是外部 kill / 磁盘 / 断电）
    }
}

/** 结束原因 → `EndCause`（判别联合摊平；只留渲染需要的三种字段） */
export function endCauseOf(end: TurnEndReason | null | undefined): EndCause | null {
    if (!end) return null;
    const out: EndCause = { type: end.type };
    if (end.type === "aborted") out.source = end.data.source;
    if (end.type === "error") {
        out.source = end.data.source;
        out.message = end.data.message;
        // 预算拒绝 = 请求**没投送出去**（用户 2026-10-20：「refused 和 stopped 都有可能只是用户发言
        // 而实际请求并未投送出去给 llm，但这不影响它已结束的状态」）
        if (end.data.source === "budget") out.delivered = false;
    }
    return out;
}

/** 归因是否"值得看一眼"（`none` / `user` 都是预期内，不提醒） */
export function isAbnormalBlame(blame: Blame): boolean {
    return blame === "limit" || blame === "service" || blame === "environment" || blame === "unknown" || blame === "defect";
}

/** 这个任务此刻的会话状态（**唯一入口**；四处消费者都走它） */
export function sessionStateOf(i: SessionStateInput): SessionState {
    const e = i.entry;
    const unread = Math.max(0, i.unread); // 负数（水位比总轮次还大，如刚 clear）一律按 0
    const stalled = e ? stalledOf(e, i.now, i.stalledMs) : false;
    const queued = e ? e.queue : 0;
    const draft = i.hasDraft === true;

    // 「聊过没有」三条真源取或：落盘会话存在 / 本进程跑过轮次 / 跨启动账本有轮次。
    // ⚠️ 不能用"注册表里有没有条目"推 —— 打开会话页就会建条目（"打开过" ≠ "说过话"）。
    const talked = i.hasSession === true || (e?.turnCount ?? 0) > 0 || (i.totalTurns ?? 0) > 0;

    if (e?.turn) {
        return { run: "running", end: null, blame: "none", tier: "expected", stalled, unread, draft, queued, seen: unread === 0 };
    }
    if (!talked) {
        // ⚠️ 队列/草稿是属性，`never` 也要如实带出来（##393 收编时曾在此把它写成 0，
        // 于是「有留言待投递的空闲会话」在任务表上显示成「已对话」—— 属性被状态分支吞掉）
        return { run: "never", end: null, blame: "none", tier: "expected", stalled: false, unread, draft, queued, seen: unread === 0 };
    }
    const end = endCauseOf(e?.lastEndReason ?? null);
    const blame = blameOf(e?.lastEndReason ?? null);
    return { run: "ended", end, blame, tier: tierOf(blame), stalled: false, unread, draft, queued, seen: unread === 0 };
}

// ─── 派生属性（判据的底层量，收编自 session-overview） ────────

/**
 * 无进展阈值：在跑的轮次**这么久没有心跳**（`turn.lastOpAt` 不动）就在界面上提示"疑似卡住"。
 *
 * 它只是**提示**，不是回收判据（##305 定案：无人值守继续烧，靠 `maxSteps` 收口；真卡死由人在
 * 这里手动中断）。取值 90s：一次工具调用（含 `sleep 20` 那类）久于它也不罕见，故宁可迟钝 ——
 * 假报警会训练用户忽略这个标记。
 */
export const STALL_MS = 90_000;

/** 主活动轴（与 `RunState` 的 running 同义，保留给总览页的措辞用） */
export function activityOf(e: SessionEntry): "working" | "idle" {
    return e.turn ? "working" : "idle";
}

/** 在跑的轮次多久没动了（无在跑 → null） */
export function idleMsOf(e: SessionEntry, now: number): number | null {
    if (!e.turn) return null;
    const t = Date.parse(e.turn.lastOpAt);
    return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

/** 疑似卡住：在跑、且心跳超过 `STALL_MS` 没动（**运行中的健康度**，不新开状态轴） */
export function stalledOf(e: SessionEntry, now: number, thresholdMs = STALL_MS): boolean {
    const idle = idleMsOf(e, now);
    return idle !== null && idle >= thresholdMs;
}

/**
 * 「距上次看新增多少条消息」：以调用方给的**已读水位**为基线（`seenTurns`，单位 = **轮次**），
 * 算到此刻的差值。**1 个轮次 = 1 条消息**（##358 口径，不是 step 数）。
 *
 * ⚠️ 总轮次必须用**跨启动那把尺子**（`totalTurns`）：`e.turnCount` 是本进程计数、重启归零，
 * 而水位是跨启动落盘的 ⇒ 两者不同尺时未读会算错。
 */
export function newTurnsOf(e: SessionEntry | null, seenTurns: number | null, totalTurns?: number): number {
    if (seenTurns === null) return 0;
    return Math.max(0, (totalTurns ?? e?.turnCount ?? 0) - seenTurns);
}

// ─── 待投递留言（三种"排队"的唯一判据） ─────────────────

export type QueueKind = "none" | "chatting" | "opened-idle" | "closed-idle";

export interface QueueView {
    kind: QueueKind;
    count: number;
    /** 短标签（chip 用）；kind="none" 时为空串 */
    label: string;
    /** 说清"这些留言什么时候会被投出去"——三档的差别正是"什么时候" */
    tip: string;
}

export function queueViewOf(e: SessionEntry): QueueView {
    const n = e.queue;
    if (n <= 0) return { kind: "none", count: 0, label: "", tip: "" };
    if (e.turn) {
        return { kind: "chatting", count: n, label: `排队 ${n}`, tip: `${n} 条留言待投递：本轮收尾后整批投给模型（##306 插话队列）` };
    }
    if (e.viewers > 0) {
        return {
            kind: "opened-idle",
            count: n,
            label: `已打开·未通讯·排队 ${n}`,
            tip: `${n} 条留言待投递：会话页开着但没在跑，下一次发言开场时投`,
        };
    }
    return {
        kind: "closed-idle",
        count: n,
        label: `已关闭·待投递 ${n}`,
        tip: `${n} 条留言待投递：没有窗口在看它，留言躺在队列里，直到下次有人开口（##303）`,
    };
}

/** 上一轮是否"不是预期内收尾"（error / 断流 / 崩溃 / 撞上限）—— 归因口径，不是 `type !== completed` */
export function abnormalEndOf(e: SessionEntry): boolean {
    return e.turn === null && isAbnormalBlame(blameOf(e.lastEndReason));
}

// ─── 图标语言（形状 ⊥ 线型 ⊥ 颜色 ⊥ 动画） ──────────────

/** 形状：只表三个阶段（色弱用户靠它分辨） */
export type GlyphShape = "hollow" | "live" | "ended";
/** 线型：待处理等级（`dashed` = 待你裁定；`double` = 我方缺陷） */
export type GlyphLine = "solid" | "dashed" | "double";
/** 颜色：只表归因 */
export type GlyphTone = "muted" | "ok" | "green" | "slate" | "amber" | "orange" | "teal" | "violet" | "red";

/** 归因 → 色（**唯一配色表**；渲染层不得自己拼） */
export const TONE_OF_BLAME: Record<Blame, GlyphTone> = {
    none: "ok", // 正常结束：灰绿
    user: "slate", // 你停止：蓝灰（不是故障）
    limit: "amber", // 我方限制：琥珀
    service: "orange", // 上游服务：橙
    environment: "teal", // 已识别环境问题：青（会再现，别慌）
    unknown: "violet", // 未识别外部：紫（待裁定）
    defect: "red", // 我方缺陷：红
};

/** 归因 → 人话短标签（**根因**文案仍从 `turn-end.ts` 取，这里只给"该谁管"的抬头） */
export function blameLabelOf(blame: Blame): string {
    switch (blame) {
        case "none":
            return "正常结束";
        case "user":
            return "你停止";
        case "limit":
            return "我方限制";
        case "service":
            return "上游服务";
        case "environment":
            return "环境问题";
        case "unknown":
            return "未识别异常";
        case "defect":
            return "我方缺陷";
    }
}

/** 图标视图（渲染层唯一输入；`SessionGlyph.tsx` 照着画） */
export interface SessionGlyphView {
    shape: GlyphShape;
    line: GlyphLine;
    tone: GlyphTone;
    motion: "none" | "live" | "slow";
    /** 短标签（tooltip / 有空间处；**行内不渲染** —— 用户 3.1 要求删掉的正是行内重复文字） */
    label: string;
    /** 未读数字角标（`+N`；'' = 无） */
    count: string;
    /** 草稿角标（`✎`） */
    draftMark: string;
    /** 队列角标（`⏸N`） */
    queueMark: string;
    tip: string;
}

function unreadText(n: number): string {
    return n > 99 ? "+99" : `+${n}`;
}

/**
 * 状态 → 图标视图（**唯一映射**）。
 *
 * `uri` 只为 tooltip 抬头用（纯展示，不参与判据）。
 */
export function glyphOf(state: SessionState, uri = ""): SessionGlyphView {
    const head = uri ? `${uri}\n` : "";
    const count = state.unread > 0 ? unreadText(state.unread) : "";
    const draftMark = state.draft ? "✎" : "";
    const queueMark = state.queued > 0 ? `⏸${state.queued}` : "";
    const bits: string[] = [];
    if (state.unread > 0) bits.push(`未读 ${state.unread} 条（1 轮 = 1 条）`);
    if (state.draft) bits.push("有未发送草稿");
    if (state.queued > 0) bits.push(queueViewOf_brief(state.queued));
    const tail = bits.length > 0 ? `\n${bits.join(" · ")}` : "";

    if (state.run === "never") {
        return {
            shape: "hollow",
            line: "solid",
            tone: "muted",
            motion: "none",
            label: "未运行",
            count,
            draftMark,
            queueMark: "",
            tip: `${head}**未运行**（这个任务还没和 agent 说过话）${tail}`,
        };
    }

    if (state.run === "running") {
        const label = state.stalled ? "停滞" : "运行中";
        return {
            shape: "live",
            line: "solid",
            tone: "green",
            motion: state.stalled ? "slow" : "live",
            label,
            count,
            draftMark: "",
            queueMark,
            tip: state.stalled
                ? `${head}**在跑，但长时间没动静**（#308 无进展判据，##305 只是提示不是回收）：\n真卡死由你手动中断。${tail}`
                : `${head}**正在回复**（没开窗口也在跑，##305）${tail}`,
        };
    }

    // ended：形状恒为 UML 终态圆，差异在线型 + 颜色 + 根因文案
    const blame = state.blame;
    const line: GlyphLine = blame === "defect" ? "double" : blame === "unknown" ? "dashed" : "solid";
    const reason = state.end ? endReasonText(state.end) : "无记录（早于 endReason 的遗留数据，不做归因）";
    const action =
        blame === "defect"
            ? "\n这是我方缺陷（人为界定的判据）：走 fix 流程。"
            : blame === "unknown"
              ? "\n分不清是我方故障还是外部原因（网络 / 磁盘 / 被 kill）：**请你裁定** —— 是 bug 还是环境问题。"
              : blame === "environment"
                ? "\n已识别的外部问题：允许发生，可能再现。"
                : "";
    return {
        shape: "ended",
        line,
        tone: TONE_OF_BLAME[blame],
        motion: "none",
        // 三态的词汇要对齐：never=「未运行」· running=「运行中」· ended=「已结束 · <归因>」
        // （`data-session-end` 拿它做一致性断言，总览表格拿它做状态列 —— 同一个词，不两套）
        label: `已结束 · ${blameLabelOf(blame)}`,
        count,
        draftMark,
        queueMark,
        tip: `${head}**已结束** · ${blameLabelOf(blame)}\n${reason}${action}${tail}`,
    };
}

function queueViewOf_brief(n: number): string {
    return `${n} 条留言待投递`;
}

/**
 * 根因 → 一句人话（**复用 `shared/turn-end.ts`，不另写文案**）。
 * 这里只补它没覆盖的一句：`error` 的细节原样带上（`llm` / `stream` 的原文最有信息量）。
 */
export function endReasonText(end: EndCause): string {
    switch (end.type) {
        case "completed":
            return "正常结束（模型自然说完）";
        case "max-steps":
            return "打满步数上限，本轮被强制收尾（设计内，不是错）";
        case "max-tokens":
            return "撞输出长度上限被截断";
        case "aborted":
            return abortText(end.source ?? "");
        case "error":
            return `错误终止（${end.source ?? "未知来源"}）${end.message ? `：${end.message}` : ""}`;
        case "interrupted":
            return "本轮未跑完（崩溃 / 被杀后补的收尾）";
    }
}

/** `TurnEndReason` → 人话（给"结束原因"那一列/详情用；内部走 `turn-end.ts`） */
export function endTextOf(end: TurnEndReason | null | undefined, notice?: string | null): string {
    const cause = endCauseOf(end);
    if (!cause) return "无记录";
    const fromTurn = turnEndText(end!, notice);
    return fromTurn ?? endReasonText(cause);
}
