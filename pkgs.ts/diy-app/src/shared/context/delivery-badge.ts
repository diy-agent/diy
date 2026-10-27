// src/shared/context/delivery-badge.ts
// 🎯 「投递」徽章的**文案真源**（##423）：徽章到底在说什么维度 + 什么时候会压。
//
// ── 病根（用户 2026-10-23）──
// 旧文案 `投递·全量` 的真实含义是「这一步一条历史消息都没丢」（**历史裁剪维度**），
// 但在 runtime 语境里读起来像「runtime 全量投递」⇒ 用户以为是 runtime 的事。
// 结论：**文案必须自带维度名**（`历史·…`），且三个跨维度的词（全量 / 投递 / 压缩）
// 不许裸用 —— 「全量」在这里既不是 runtime 全量、也不是会话全量，只表示「本轮没人被丢」。
//
// ── 口径（##432 刀 2 之后）──
// 保留量 = 压缩时窗口 × `history.limit.retainRatio`（token）。所以徽章里的数**一律 token**：
// 「丢多少 / 留多少 / 上限多少」同一个数域，不再拿 `keptBytes` 去跟 token 上限比（那是两个口径）。
// 老账本没有 `keptTokens` / `droppedTokens` → 只报条数，**不推算**（推算出来的 token 只能骗人）。
//
// ── 为什么做纯函数 ──
// 徽章文本 / hover 是**契约**（意图测试断言它），必须可单测；组件只负责取数。
// 文案归出口：主进程不拼句子，渲染层不拼数字，这份函数同时被 UI 用与单测钉。

/** 该步（轮首）投递时的历史选择事实（= `StepUsageRecord.historySelection`） */
export interface DeliverySelection {
    /** 本步生效的**历史保留量**（token = 窗口 × `history.limit.retainRatio`） */
    retainTokens: number;
    /** 保留段估算 token（与上限同口径）；老账本没有 → 缺省 */
    keptTokens?: number;
    /** 被省掉那段估算 token（与上限同口径）；老账本没有 → 缺省 */
    droppedTokens?: number;
    keptBytes: number;
    keptRuns: number;
    droppedMessages: number;
    totalMessages: number;
}

/** 已落盘的压缩边界（turns.jsonl 的 compaction entry） */
export interface DeliveryBoundary {
    at: string;
    /** 那一次丢掉的**消息条数**（= llm.jsonl 行数） */
    droppedMessages: number;
    retainTokens: number;
}

export interface DeliveryBadgeInput {
    selection: DeliverySelection;
    /**
     * 当前已落盘的压缩边界（= 本步投递用的那个切点）。
     * `null` = 从没压过（本步投递的是全量）；`undefined` = 没取到（不写这块）。
     */
    boundary?: DeliveryBoundary | null;
}

/** 触发器 / 边界事件 → 人读短名（徽章与压缩详情共用同一套词） */
export const TRIGGER_LABEL = {
    manual: "手动",
    systemContextChanged: "系统上下文变",
    cacheExpired: "缓存过期",
    contextWindowOver: "窗口超限",
} as const;

/** 字节人读（只给装配层硬上限这种「字节域」的数用；历史口径一律 token） */
export function fmtBudgetBytes(n: number): string {
    return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

/** token 人读（千位分隔） */
export function fmtLimitTokens(n: number): string {
    return `${Math.round(n).toLocaleString()} token`;
}

/** token 短写（徽章里放不下千位分隔）：`3400 → 3.4k` / `820 → 820` */
export function fmtTokensShort(n: number): string {
    if (n < 1000) return String(Math.round(n));
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * 徽章**文本**：维度必须写在词里（`历史·…`），不再出现裸「全量」。
 *
 * 数字口径 = **token**（与上限同一个数域）：`历史·丢 3.4k tok`。
 * 老账本没有 token 数时退回条数（`历史·丢 3 条`）—— 宁可少说，也不拿字节换算。
 */
export function deliveryBadgeText(sel: DeliverySelection): string {
    if (sel.droppedMessages <= 0) return "历史·无裁剪";
    return typeof sel.droppedTokens === "number"
        ? `历史·丢 ${fmtTokensShort(sel.droppedTokens)} tok`
        : `历史·丢 ${sel.droppedMessages} 条`;
}

/**
 * 徽章 **hover 全文**（多行）。
 *
 * 三块，缺一不可：
 *   ① 维度：这是**历史裁剪**，与 runtime 无关；数全是 token（老账本才退回条数）
 *   ② 什么时候会压：**事件制**（首次顶过上限 / 保留段再顶过一次 / 其余步按已落盘边界切 / 手动）
 *   ③ 自动压缩 mode 那三个触发器只写审计，不改切点 —— 划清界线，别再让用户以为徽章在说 runtime
 */
export function deliveryBadgeTitle(input: DeliveryBadgeInput): string {
    const s = input.selection;
    const out: string[] = [];

    // ① 本步事实（token 域）
    const kept = typeof s.keptTokens === "number" ? fmtTokensShort(s.keptTokens) + " tok" : "无记录";
    const dropped =
        typeof s.droppedTokens === "number" ? `（${fmtTokensShort(s.droppedTokens)} tok）` : "";
    out.push(
        `历史裁剪（本步投递的唯一维度，与 runtime 无关）：保留 ${fmtLimitTokens(s.retainTokens)}` +
            ` · 保留 ${kept} · 丢 ${s.droppedMessages}/${s.totalMessages} 条${dropped} · ${s.keptRuns} 段`,
    );
    out.push(
        "口径：token 粗估（中文 1 字 1 token、其余 4 字符 1 token）—— 与上限同一个数域，" +
            "所以「丢多少 / 留多少」可以直接和上限比（字节口径已退场，只在装配层硬上限里用）。",
    );

    // ② 什么时候会压（事件制）
    if (input.boundary !== undefined) {
        const b = input.boundary;
        out.push(
            b
                ? `切点来自 ${b.at} 写的压缩事件（当时丢 ${b.droppedMessages} 条、保留 ${fmtLimitTokens(b.retainTokens)}）：` +
                      "之后每步只按它切，不重算。"
                : "还没有压缩事件：本步投递的是全量（全量估算一旦超上限，发请求前会算一次切点并写事件）。",
        );
        out.push(
            "再压的条件：**只看保留段自己**重新涨过上限（被丢掉那段不算，否则每步都「超限」）；" +
                "或用「压缩」按钮手动压一次。",
        );
    }

    return out.join("\n");
}
