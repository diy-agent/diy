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
