/**
 * session-resume.ts — 「**继续工作**」区的判据（##358 D4，纯函数，单测在 `tests/core/session-resume.test.ts`）。
 *
 * 用户原话（##180，2026-10-16）—— 这一区就是那句痛点的正面回答：
 *   「我 app 启动后，丢了所有进度，挺麻烦的，我还是需要一种『**我要接着工作、知道最近我在干啥**』的提示，
 *     不然还要一个个点进去看，如何完成呢？」
 *
 * 【与另外两区的分工（nav 上三个区，同一份 `NavRow`，按"要不要你动手"切）】
 *   · 「待你处理」= **有一笔账在等你**（异常终止没看 / 卡住 / 有人在等 / 跑完没看）→ 有原因短语。
 *   · 「后台活动」= 只是**在动**（在跑，关了也跑，##305）。
 *   · 「继续工作」= **眼下没事**，但你最近确实在这儿干过 ⇒ 按**最后活动时间**倒序给一条时间轴。
 *   同一会话**绝不两处同时出现**（App 侧把前两区已收走的 uri 传进来 `taken`）。
 *
 * 【为什么要"最近活动时间"这把尺子，而不是任务 `updated`】
 *   任务 `updated` 是元数据（改个标题也会动），而这一区问的是"**我最后在这儿说过话是什么时候**"
 *   ⇒ 取账本最后一条账的 `ts`（`NavRow.lastTs`，落盘、跨启动，正是 `usage.jsonl` 那一份）。
 *   `lastTs` 为空 = 没聊过 ⇒ **不进本区**（不编时间，也就不会拿"从未开始"冒充"最近在干"）。
 *
 * 【为什么不砍终态任务（done / cancelled）】
 *   与 §10 扫描次序同一条理由：终态 ≠ 我不想回头看一眼（它可能还有没看完的轮次）。
 *   本区只排"最近"，不替用户判"这事结束了"——判结束是任务状态的事，不是这一区的职责。
 */
import type { NavRow } from "./session-nav";
import { fmtStamp } from "./session-overview";

/** 本区最多列几行——nav 上它是**第三顺位**的区，长了就把前两区挤出视野 */
export const RESUME_LIMIT = 5;

export interface ResumeView {
    /** 按最后活动时间倒序的行（最多 `RESUME_LIMIT` 条） */
    items: NavRow[];
    /** 被截掉的更早会话条数（>0 时表尾给一句"还有 N 条更早的"，不静默吞） */
    more: number;
}

/**
 * 「**继续工作**」区的行 = 最近活动过、**眼下没事**、**没开着 tab** 的会话，按最后活动时间倒序。
 *
 * @param rows  全量 nav 行（`navRows()`，含账本独有行 —— 重启后本区才有东西）
 * @param taken 已被「待你处理」/「后台活动」收走的 uri（去重靠调用方传入，判据不重复实现）
 */
export function resumeOf(rows: NavRow[], taken: Iterable<string>, limit: number = RESUME_LIMIT): ResumeView {
    const skip = new Set(taken);
    const cand = rows
        .filter((r) => !r.opened && !skip.has(r.uri) && !!r.lastTs)
        .sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? "") || a.uri.localeCompare(b.uri));
    // 排序键是 ISO 串：字典序 = 时间序（同一时区、同一格式），故不必 new Date（也避开 NaN 比较）
    return { items: cand.slice(0, Math.max(0, limit)), more: Math.max(0, cand.length - limit) };
}

/** 每行右侧的时间（`MM-DD HH:mm`）——与「待你处理」区同格式（同一个 `fmtStamp`，不再写一套） */
export function resumeWhenOf(r: NavRow): string {
    return fmtStamp(r.lastTs);
}

/** 表尾那句"还有更早的"（空 → 空串，调用方据此不渲染） */
export function resumeMoreTextOf(v: ResumeView): string {
    return v.more > 0 ? `还有 ${v.more} 条更早的` : "";
}
