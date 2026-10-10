// src/shared/calendars.ts
// 🎯 日历表（工作日定义）的**形状 + 判定**（纯数据 + 纯函数，无 node 依赖）。
//
// 为什么需要它：价格里有时段档（如 DeepSeek 的峰/谷价）。时段边界之外还常叠一层
// 「工作日 / 节假日」——而**「周中的法定假日」与「周末调休补班」算法推不出**（前者是每年
// 国务院公告的政治决定），只能靠数据表。故日历独立成表，时段档只**引用**它的 id。
//
// 日历 ≠ 地域：`CN` 是 ISO 3166 国家码（指地理），我们要的是「工作日定义」，同一地域可有
// 多套（`CN-business-day` / 将来 `CN-bank-day`）。故 id 用语义 slug + `label` 多语言。
//
// 与 tz 无关：时段用 ISO 8601 的**带偏移时刻** `01:00:00+08:00` 表达，偏移内嵌 ⇒ 无需 tz 字段。
// 判定：把 UTC 毫秒折算到该偏移的「本地日」→ 比对时段 → 命中再查日历。
//
// 失败语义（承「不可测 ≠ 0」：绝不静默用错价）
//   · 引用不存在的日历 id → 该窗**不命中**（退到 base 价；调用方告警）
//   · 日期超出 `coverage`（公告未发）→ 退化为纯 `base.days`（周末规则），不算错，只是不精确

/** 一份日历定义。判定优先级：`workdays` > `holidays` > `base.days` */
export interface CalendarDef {
    /** 展示名（UI 多语言；缺失回退 id） */
    label?: { zh?: string; en?: string };
    /** 基准周规则（ISO 周序号：1=Mon … 7=Sun）——「平时按周几算」，调休由下面两表推翻 */
    base: { days: number[] };
    /** 该表的**可信区间**（公告覆盖范围）；超出 → 退化为 base.days */
    coverage?: { from: string; to: string };
    /** 强制非工作日：`{"2026-01-01":"元旦"}`（法定假日） */
    holidays?: Record<string, string>;
    /** 强制工作日：`{"2026-01-04":"元旦调休"}`（周末补班） */
    workdays?: Record<string, string>;
}

/** 日历表：id → 定义（运行时由 main 读 `src/main/data/calendars.json` 灌入） */
export type CalendarTable = Record<string, CalendarDef>;

/** `01:00:00+08:00` / `23:30:00Z` —— 时间 + 必填偏移（ISO 8601 合法形式） */
const TIME_OF_DAY_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;

/** 解析出的「时刻」：`minutes` = 该偏移下的当日分钟数；`offsetMs` = 与 UTC 的偏移 */
export interface TimeOfDay {
    minutes: number;
    offsetMs: number;
}

/**
 * 解析带偏移的 ISO 8601 时刻。**缺偏移直接 null**（不默认本地时区 —— 歧义就是静默错档）。
 * 注意不能用 `new Date("01:00:00+08:00")`：那是 Invalid Date（无日期部分），必须自解析。
 */
export function parseTimeOfDay(s: string): TimeOfDay | null {
    const m = TIME_OF_DAY_RE.exec(s.trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = m[3] === undefined ? 0 : Number(m[3]);
    if (hh > 24 || mm > 59 || ss > 59) return null;
    const minutes = hh * 60 + mm + (ss > 0 ? 1 : 0); // 秒级精度不进分钟（24:00 表示当日末尾）
    if (minutes > 24 * 60) return null;
    const off = m[4]!;
    let offsetMs = 0;
    if (off !== "Z") {
        const sign = off[0] === "-" ? -1 : 1;
        const oh = Number(off.slice(1, 3));
        const om = Number(off.slice(4, 6));
        if (oh > 23 || om > 59) return null;
        offsetMs = sign * (oh * 60 + om) * 60_000;
    }
    return { minutes, offsetMs };
}

/**
 * 时段档的触发条件（归一化形状，见 shared/usage.ts 的 `TierWhen`）。
 *   · `startMin <= endMin` → 当日内闭开区间 `[start, end)`
 *   · `endMin < startMin`  → **跨零点**（如 `22:00:00+08:00` → `02:00:00+08:00`）
 */
export interface UtcRangeWindow {
    startMin: number;
    endMin: number;
    offsetMs: number;
    /** 日历 id；缺省 = 不查日历（时段内每天都算） */
    calendar?: string;
    /** 该时段展示名（如 `"peak"` / `"off-peak"`）；缺省 = 上层 `baseLabel` */
    label?: string;
}

/** ISO 周序号：1=Mon … 7=Sun（`Date.getUTCDay()` 的 0=Sun 映射过来） */
export function isoWeekday(d: Date): number {
    const w = d.getUTCDay();
    return w === 0 ? 7 : w;
}

/** 把 UTC 毫秒折算到指定偏移下的「本地日」视图（用 getUTC* 读 = 本地字段，不用宿主时区） */
export function localParts(atMs: number, offsetMs: number): { ymd: string; minutes: number; weekday: number; date: Date } {
    const d = new Date(atMs + offsetMs);
    return {
        ymd: d.toISOString().slice(0, 10),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        weekday: isoWeekday(d),
        date: d,
    };
}

/** 单个日历的工作日判定：`workdays` > `holidays` > `base.days` */
export function isWorkday(def: CalendarDef, ymd: string, weekday: number): boolean {
    if (def.workdays && ymd in def.workdays) return true;
    if (def.holidays && ymd in def.holidays) return false;
    return def.base.days.includes(weekday);
}

/** 日历 + 日期 → 是否工作日；**id 不存在 → false**（调用方据此告警，绝不静默当真） */
export function isWorkdayById(tables: CalendarTable, id: string, ymd: string, weekday: number): boolean {
    const def = tables[id];
    if (!def) return false;
    if (def.coverage && (ymd < def.coverage.from || ymd > def.coverage.to)) {
        // 公告未发（如 2027 年还没出）→ 退化为纯周规则：不是错，只是不精确
        return def.base.days.includes(weekday);
    }
    return isWorkday(def, ymd, weekday);
}

/**
 * 时段窗是否命中（`atMs` = 请求**发起**时刻，UTC 毫秒）。`endMin` 边界为**开**（`< end`）。
 * `calendar` 缺省 = 只看时段；给了但表里没有该 id → **不命中**（不是「当真」）。
 */
export function matchUtcRange(w: UtcRangeWindow, atMs: number, tables: CalendarTable): boolean {
    const { ymd, minutes, weekday } = localParts(atMs, w.offsetMs);
    const inRange =
        w.startMin <= w.endMin
            ? minutes >= w.startMin && minutes < w.endMin
            : minutes >= w.startMin || minutes < w.endMin; // 跨零点
    if (!inRange) return false;
    if (!w.calendar) return true;
    return isWorkdayById(tables, w.calendar, ymd, weekday);
}

/** 日历 id → 展示名（UI；缺失回退 id） */
export function calendarLabel(def: CalendarDef | undefined, id: string, lang: "zh" | "en" = "zh"): string {
    return def?.label?.[lang] ?? def?.label?.en ?? id;
}
