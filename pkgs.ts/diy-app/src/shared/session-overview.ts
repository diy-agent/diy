/**
 * session-overview.ts — **全局会话可见性**（##308）的呈现判据（纯函数，renderer 与单测共用）。
 *
 * 数据源 = `agent.local.sessions`（注册表，`shared/registry-frame.ts` 的 `SessionEntry`）：
 *   一条**全局**订阅的「快照 + delta」，只搬状态（R2）。本文件把它翻成"人看的东西"：
 *   活动标记 / 步数进度 / 待投递留言 / 谁在看 / 已跑多久 / 无进展 / 异常退出。
 *
 * 【三条约束（照 ##308 的定案）】
 *   ① **主状态轴只有一条**：`working`（有轮次在跑）/ `idle`。`queue` / `viewers` / `steps` /
 *      `lastActivity` 全是**属性**，挂在同一行上，不另开状态。
 *   ② **三种「排队」必须可区分**（用户明确要的可见性）：对话中排队 / 已打开未通讯排队 /
 *      已关闭待投递 —— 判据 = `turn != null` × `viewers > 0`（`queueViewOf` 一处定义）。
 *   ③ **观测不污染（R3）**：这些函数只读注册表条目；`viewers` 是**数据**不是我们能改的东西
 *      （总览 / nav / 任务表都不许把自己算进去 —— 那由 main 侧结构性保证，见 session-registry）。
 *
 * 为什么是纯函数：三处消费者（总览页 / nav 标签 / 任务表行）必须**同一套判据**，
 * 否则"同一个会话在 nav 说在跑、在任务表说空闲"这类分叉必然发生。渲染只负责画。
 */

import { endMarkOf } from "./turn-end";
import type { SessionEntry } from "./registry-frame";

/** 主状态轴（唯一）：有轮次在跑 / 没有 */
export type SessionActivity = "working" | "idle";

export function activityOf(e: SessionEntry): SessionActivity {
    return e.turn ? "working" : "idle";
}

/**
 * 无进展阈值：在跑的轮次**这么久没有心跳**（`turn.lastOpAt` 不动）就在界面上提示"疑似卡住"。
 *
 * 它只是**提示**，不是回收判据（##305 定案：无人值守继续烧，靠 `maxSteps` 收口；真卡死由人在
 * 这里手动中断）。取值 90s：一次工具调用（含 `sleep 20` 那类）久于它也不罕见，故宁可迟钝 ——
 * 假报警会训练用户忽略这个标记。
 */
export const STALL_MS = 90_000;

/** 此刻累计步数（在跑轮次的当前步 + 本进程内已收尾轮次的累计） */
export function stepsNow(e: SessionEntry): number {
    return e.totalSteps + (e.turn?.steps ?? 0);
}

/** 在跑的轮次多久没动了（无在跑 → null） */
export function idleMsOf(e: SessionEntry, now: number): number | null {
    if (!e.turn) return null;
    const t = Date.parse(e.turn.lastOpAt);
    return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

/** 疑似卡住：在跑、且心跳超过 `STALL_MS` 没动（判据只在"有没有在跑"之上加一层，不新开状态轴） */
export function stalledOf(e: SessionEntry, now: number, thresholdMs = STALL_MS): boolean {
    const idle = idleMsOf(e, now);
    return idle !== null && idle >= thresholdMs;
}

/**
 * 「距上次看新增多少步」：以调用方给的**已读水位**为基线（`seenSteps`），算到此刻的步数差。
 *
 * 水位是 renderer 本地量（谁在看、看到哪一步，见 sessionStore）—— 它**不回写 viewers**（R3）：
 * 这是"我读到了哪"，不是"有人在读"。
 */
export function newStepsOf(e: SessionEntry, seenSteps: number | null): number {
    if (seenSteps === null) return 0;
    return Math.max(0, stepsNow(e) - seenSteps);
}

/** 步数进度（`k/maxSteps`；`maxSteps` 未知时只给已跑步数，不编上限） */
export interface StepsProgress {
    done: number;
    limit: number | null;
    /** 0..1（limit 未知 → null，调用方不画进度条） */
    pct: number | null;
    text: string;
}

export function stepsProgressOf(e: SessionEntry, maxSteps: number | null): StepsProgress {
    const done = stepsNow(e);
    const limit = maxSteps && maxSteps > 0 ? maxSteps : null;
    return {
        done,
        limit,
        pct: limit ? Math.min(1, done / limit) : null,
        text: limit ? `${done}/${limit}` : `${done} 步`,
    };
}

/**
 * 待投递留言（`queue`）的三档 —— **三种「排队」的唯一判据**（#308 定案②）。
 *
 *   · `chatting`    —— 打开·对话中 + queue>0（##306：本轮收尾后整批投）
 *   · `opened-idle` —— 打开·未通讯 + queue>0（页面开着，但没在跑）
 *   · `closed-idle` —— 关闭·idle + queue>0（##303 的洞：没人看它，留言躺着等下次开口）
 *
 * 判据只用 `turn` / `viewers` 两个字段 —— 不允许再按"哪个页面开着"另算（那会让同一会话
 * 在总览与 nav 上显示不同档）。
 */
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
        return {
            kind: "chatting",
            count: n,
            label: `排队 ${n}`,
            tip: `${n} 条留言待投递：本轮收尾后整批投给模型（##306 插话队列）`,
        };
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

/**
 * 「非正常收尾」：最后一轮的结束原因不是 `completed`。
 *
 * 用 `endReason.type` 判（##288 的事实位），**不猜**日志。`completed` 之外都值得一眼看见：
 * 错误 / 流中断 / 用户中断 / 撞上限。
 */
export function abnormalEndOf(e: SessionEntry): boolean {
    return e.turn === null && !!e.lastEndReason && e.lastEndReason.type !== "completed";
}

/** chip 文案（nav 标签与任务表行**同一份**，宽窄由调用方截断） */
export interface SessionChipView {
    /** daisyUI 语义色（badge-<tone>） */
    tone: "primary" | "warning" | "error" | "ghost";
    icon: string;
    text: string;
    /** tooltip：把判据说全（uri / 模型 / 步数 / 留言 / 看客 / 时长 / 上次结束） */
    tip: string;
}

/**
 * 会话 chip：**一行说完**这个会话现在怎么了；`null` = 没什么可说的（调用方不渲染）。
 *
 * 刻意**不给空闲且无事的会话发 chip** —— 任务表几百行，人人都挂个"空闲"等于噪音；
 * chip 出现即"有事"（在跑 / 有留言 / 有未读新增 / 上一轮不是正常收尾）。
 */
export function sessionChipOf(
    e: SessionEntry,
    opts: { seenSteps: number | null; maxSteps: number | null; now: number },
): SessionChipView | null {
    const base = tipOf(e, opts.maxSteps, opts.now);
    const q = queueViewOf(e);
    const add = newStepsOf(e, opts.seenSteps);

    if (e.turn) {
        const prog = stepsProgressOf(e, opts.maxSteps);
        const stalled = stalledOf(e, opts.now);
        const bits: string[] = [prog.text];
        if (stalled) bits.push(`停滞 ${fmtDuration(idleMsOf(e, opts.now) ?? 0)}`);
        if (q.kind !== "none") bits.push(q.label);
        if (e.viewers === 0) bits.push("无人看");
        if (add > 0) bits.push(`新增 ${add} 步`);
        return {
            tone: stalled ? "warning" : "primary",
            icon: "●",
            text: bits.join(" · "),
            tip: base,
        };
    }

    // 空闲：留言 / 异常收尾 / 未读新增，按"用户更该知道"排先后
    if (q.kind !== "none") {
        return { tone: "warning", icon: "⏸", text: q.label, tip: base };
    }
    if (abnormalEndOf(e)) {
        const mark = endMarkOf(e.lastEndReason, false);
        return {
            tone: mark.tone === "err" ? "error" : "warning",
            icon: mark.icon,
            text: mark.tip,
            tip: base,
        };
    }
    if (add > 0) {
        return { tone: "ghost", icon: "◎", text: `新 ${add} 步`, tip: base };
    }
    return null;
}

/** chip / 行的公用 tooltip：把这条会话的判据一次说全 */
export function tipOf(e: SessionEntry, maxSteps: number | null, now: number): string {
    const uri = e.refs.find((r) => r.kind === "task")?.uri ?? e.id;
    const lines = [`${uri}（会话 ${e.id}）`];
    if (e.turn) {
        const prog = stepsProgressOf(e, maxSteps);
        const runMs = Date.parse(e.turn.startedAt);
        lines.push(
            `在跑：${prog.text} 步 · 本轮 ${fmtTokens(e.turn.tokens)} tokens` +
                (Number.isFinite(runMs) ? ` · 已跑 ${fmtDuration(now - runMs)}` : ""),
        );
        if (e.turn.model) lines.push(`模型：${e.turn.model}`);
        if (e.turn.state === "detached") lines.push("此刻无人观察（轮次仍在跑，##305）");
    } else {
        lines.push(`空闲：本进程内跑过 ${e.turnCount} 轮 / 累计 ${e.totalSteps} 步 · ${fmtTokens(e.totalTokens)} tokens`);
        const mark = endMarkOf(e.lastEndReason, false);
        if (mark.tip) lines.push(`上一轮：${mark.tip}`);
    }
    lines.push(`看客 ${e.viewers} · 待投递留言 ${e.queue}`);
    lines.push(`首次见到 ${e.firstSeenAt} · 最后活动 ${e.lastActivity}`);
    return lines.join("\n");
}

/** 时长（ms → `12s` / `3m05s` / `1h02m`）：界面上只读个大概，不显示毫秒 */
export function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** token 数（小数量精确、大数量 k 近似：`k/maxSteps` 那行旁边不该被 5 位数字撑破） */
export function fmtTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(1)}k`;
}
