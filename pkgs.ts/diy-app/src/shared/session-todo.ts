/**
 * session-todo.ts — 「**待你处理**」区的判据（##358 D5，纯函数，单测在 `tests/core/session-todo.test.ts`）。
 *
 * 用户原话（##180，2026-10-16）：
 *   「app 启动后丢了所有进度……我需要一种『我要接着工作、知道最近我在干啥』的提示，
 *     不然还要一个个点进去看，如何完成呢？」
 *   「其他你想想，看看如何让用户快速了解自己在干啥」
 *
 * 【与「后台活动」区（D2）的分工 —— 两个区看**同一份行**，按"要不要你动手"切】
 *   · 「待你处理」= **有一笔账在等你**：异常终止没看 / 卡住没动 / 有人在等你回话 / 跑完了没看。
 *     这些**需要你（或至少值得你）动手**，所以带**原因短语**（不点进去就知道为什么找你）+ 最后活动时间。
 *   · 「后台活动」= 只是**在动**（在跑，##305 关了也在跑）—— 不需要你回话，看到就安心。
 *   同一会话**绝不两处同时出现**（App 侧从后台区里减掉已被"待你处理"收走的那批）。
 *
 * 【为什么原因短语要在判据层给】
 *   用户要的是"**不点进去就知道**"。若把"为什么找你"留到组件里各写一遍，两处判据立刻分叉
 *   （##308 的教训：同一个会话在 nav 说"已开始"、在任务表说"空闲"）。所以这里出的是**结论**。
 *
 * 【跨启动】
 *   行里可以**没有注册表条目**（重启后注册表为空，但账本还记得这个任务聊过几轮）——
 *   未读走 `newTurnsOf(entry|null, seen, totalTurns)`，`totalTurns` 是账本那把跨启动的尺子。
 *   于是"重启后丢了所有进度"这件事在这里被直接回答：清单不空。
 */
import type { NavRow } from "./session-nav";
import { fmtStamp } from "./session-overview";

/**
 * 该不该找你 —— 四类，**有先后**（同一会话只报最该看的那一类）。
 *
 * 顺序 = 「值不值得看」（用户口径）：**异常终止 > 卡住 > 有人在等 > 跑完没看**。
 * 注意 `running` 不在其中：在跑是「后台活动」的事，不是"待你处理"。
 */
export type TodoKind = "failed" | "stalled" | "waiting" | "finished";

export interface TodoItem {
    /** 排好序的行本身（角标复用 `rowBadgeOf`，配色/文案与 nav 同一份） */
    row: NavRow;
    kind: TodoKind;
    /** 该看几条（未读条数 / 留言条数；"卡住"没有条数 → 0） */
    count: number;
    /** **不点进去就知道的原因**（一句话，说清"为什么找你"） */
    why: string;
}

/** 一个会话该不该找你；不该则 `null` */
export function todoKindOf(r: NavRow): TodoKind | null {
    if (r.abnormal && r.unread > 0) return "failed";
    if (r.stalled) return "stalled";
    if (r.queue > 0) return "waiting";
    // ⚠️ 在跑的会话**不算"跑完没看"**：它还没跑完。实测踩到过 —— 此刻账本已经把**在跑的这一轮**
    // 记了几行（每步一条账），`unread` 于是 > 0，判据若只看 unread 就会说"跑完了 · 1 条未读"，
    // 而同一行的角标同时写着"运行中"（`rowBadgeOf` 先看 running）⇒ **一行两句话自相矛盾**。
    if (r.running) return null;
    if (r.unread > 0) return "finished";
    return null;
}

/** 「值不值得看」的位次（越小越前）—— 也是本区的行序 */
function rankOf(kind: TodoKind): number {
    return kind === "failed" ? 0 : kind === "stalled" ? 1 : kind === "waiting" ? 2 : 3;
}

/**
 * 原因短语（判据只此一处）。
 *
 * `waiting` 要看队列的**来源**（##435）：队列的收件人是 agent，不是人 —— job 结束通知 /
 * 别的 agent 派活也走同一个队列，那些条人类零动作。只按总数写「等你回复」，
 * 就是把用户拽进来让他对着自己无事可做的一行发呆。
 */
function whyOf(kind: TodoKind, count: number, queueHuman: number): string {
    switch (kind) {
        case "failed":
            return `异常终止 · ${count} 条未读`;
        case "stalled":
            return "无进展 · 在跑但长时间没动静";
        case "waiting":
            return queueHuman > 0 ? `有 ${count} 条留言等你回复` : `有 ${count} 条自动留言待投递（无需回复）`;
        case "finished":
            return `跑完了 · ${count} 条未读`;
    }
}

/**
 * 「**待你处理**」区的行 = 有一笔账在等你、且**没开着 tab** 的会话。
 *
 * 为什么排除"开着"：开着 = 已经在你眼前了，再列一遍是噪声（与「后台活动」同一判据来源 `opened`）。
 * 行序 = 值不值得看 → 条数多者优先 → uri（保证顺序稳定，不随刷新抖动）。
 */
export function todoOf(rows: NavRow[]): TodoItem[] {
    const out: TodoItem[] = [];
    for (const r of rows) {
        if (r.opened) continue;
        const kind = todoKindOf(r);
        if (!kind) continue;
        const count = kind === "waiting" ? r.queue : kind === "stalled" ? 0 : r.unread;
        out.push({ row: r, kind, count, why: whyOf(kind, count, r.queueHuman) });
    }
    return out.sort(
        (a, b) =>
            rankOf(a.kind) - rankOf(b.kind) ||
            b.count - a.count ||
            a.row.uri.localeCompare(b.row.uri),
    );
}

/** 每行右侧的时间（`MM-DD HH:mm`；账本没记 → 空串，不编时间） */
export function todoWhenOf(i: TodoItem): string {
    return fmtStamp(i.row.lastTs);
}

/** 本区的标题行计数用文案（`N 件事等你`；空 → 空串，调用方据此不渲染标题） */
export function todoTitleOf(items: TodoItem[]): string {
    return items.length === 0 ? "" : `${items.length} 件事等你`;
}
