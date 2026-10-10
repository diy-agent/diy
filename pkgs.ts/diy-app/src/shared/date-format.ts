// src/shared/date-format.ts
// 🎯 时间显示的唯一格式化入口（纯函数；renderer 与测试共用）。
//
// 为什么抽出来：时间处处都要显示（任务树两列、上下文树页的真发轮次…），各写一份必然
// 出现"有的显示秒、有的不显示"的漂移。格式按**扫读**优化：不含年份、分钟精度
// （列表里一眼看出"多久以前"就够，秒是噪音；要精确值走 title 属性看原始 ISO）。

/** `MM-DD HH:MM`（无效/空 → 空串；调用方自己决定占位） */
export function fmtShortTime(iso: string | undefined | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `HH:MM:SS`（同一天内的比较用；如"第 2 步 vs 第 1 步"的时间） */
export function fmtClock(iso: string | undefined | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间（"3 分钟前"）；用于列表里判断"这是刚才那轮还是昨天的" */
export function fmtAgo(iso: string | undefined | null, now: number = Date.now()): string {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const s = Math.round((now - t) / 1000);
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
}

/**
 * turn 块 id → 时刻（`t` + 13 位 epoch 毫秒，如 `t1759512744123`）。
 *
 * 这是**协议契约**（不是巧合）：main 侧 `local-agent.ts` 用 `t${Date.now()}` 造 turnId，
 * step/tool/think 块 id 全部以它为前缀（`<turnId>_s1`…），所以一个 turn 块的 id 自带
 * 该轮的起点时刻 —— 这是对话流里**唯一**的时间真源（Op 协议无 ts 字段，块结构也没有）。
 *
 * 旧日志可能有非此形状的 id（改名/迁移前），解析不出的**不编时间**、返回 null：
 * 宁可没有时间，也不能显示一个假时刻（与 byline 的"当时人物未知"同一原则）。
 */
export function turnTimeOf(turnId: string | undefined | null): Date | null {
    if (!turnId) return null;
    const m = /^t(\d{13})$/.exec(turnId);
    if (!m) return null;
    const d = new Date(Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * turnId → `MM-DD HH:MM` —— **turn 级时刻的唯一展示格式**（对话流轮首消息 / 用量卡 / 明细抽屉共用）。
 *
 * 带日期（而非只 HH:MM）：会话天然跨天，只写 14:07 时"昨天下午那句"和"刚才那句"长得一样，
 * 回头定位就失去意义。**不提供 HH:MM 短版**：同一事实两种精度并列，读的人要重新判断
 * "这两个数为什么不一样"，而省下的几个字符不值这个代价（##257 review1-3）。
 *
 * ⚠️ 它是**轮**的事实（turnId 就是该轮起点）。一轮里所有块的时间戳完全相同，所以对话流里
 * 一轮只显示一次（挂在该轮首个消息块上，见 `LocalChatPage.TurnBlock.timeAnchorId`）——
 * 按块渲染会让同一轮把同一个数印四五遍（##257 review2-3）。
 */
export function fmtTurnStamp(turnId: string | undefined | null): string | null {
    const d = turnTimeOf(turnId);
    if (!d) return null;
    return fmtShortTime(d.toISOString());
}

/** turnId → `YYYY-MM-DD HH:MM:SS`（title 里的精确值；hover 才看，不占版面） */
export function fmtTurnFull(turnId: string | undefined | null): string | null {
    const d = turnTimeOf(turnId);
    if (!d) return null;
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
