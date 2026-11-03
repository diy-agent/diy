/**
 * task-agent-state.ts — **窗口占用**判据（##339 / ##262；纯函数，renderer 与单测共用）。
 *
 * 【##393 已经砍掉这里原来的「任务四态单轴」】
 *   原文件把 `in-turn > unread > draft > clean > idle` 五态当成**一条互斥状态轴**，
 *   于是「有未读」被显示成一个运行状态、并和 `+N` 在同一行说了两遍（用户 3.1），
 *   「对话中」也不与 nav 的图标同形（用户 3.2）。病根是**把属性当状态**。
 *   ⇒ 状态判据已整体迁到 `shared/session-state.ts`（三态 + 正交属性），**本文件不再判状态**。
 *   这里只剩与状态无关的「窗口占用」——名字保留是因为调用点很多，改名只会制造噪音。
 */

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
