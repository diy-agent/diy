// local.ts — 本地时区 ISO 串的唯一实现（##483）
//
// 为什么不用 `Date.prototype.toISOString()`：它恒为 UTC（`2026-10-31T03:29:25.403Z`），
// 人读日志得心算 -8 小时；串里又没有时区，跨机器 / 跨时区看同一份记录也说不清是哪的时间。
// 约定改成**本地时区 + 偏移**：`2026-10-31T11:29:25.403+0800` —— 人一眼是上午 11 点，
// 偏移在串里 ⇒ 时刻仍然无歧义（`new Date()` 解析回来是同一个 instant）。
//
// 偏移**不带冒号**（`+0800` 而非 `+08:00`）：与 session 桶文件名 `…-115000+0800.jsonl`
// 同一形态，判据正则只需一条。两种形式 V8 都解析得了 —— 由 tests 的 round-trip 钉住。
//
// ⚠️ 由此带来的一条硬约束：**不同偏移的 ISO 串不能比字典序**（`…03:00Z` 与 `…11:00+0800`
// 是同一时刻，字典序却差 8 小时；历史数据里还是清一色 `Z`）。要比时刻用 `compareInstant`。

import { TimeError } from './errors.js';

/** 两位补零（月 / 日 / 时 / 分 / 秒 / 毫秒） */
function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** 有效时刻校验：坏 Date 一律抛（见 errors.ts 头注：不静默产出假时间串） */
function assertValid(d: Date): number {
    const ms = d.getTime();
    if (!Number.isFinite(ms)) {
        throw new TimeError('time/invalid-date', '需要有效时刻（Date 的 getTime() 为 NaN）', String(d));
    }
    return ms;
}

/**
 * 本地时区偏移：`+0800` / `-0530` / `+0000`。
 *
 * 取自 `Date#getTimezoneOffset()`（= UTC - 本地，单位分钟，符号与直觉相反），
 * 故取反；`d` 决定**当期**偏移（有 DST 的时区夏冬不同，别缓存成常量）。
 */
export function localOffset(d: Date = new Date()): string {
    assertValid(d);
    const minutes = -d.getTimezoneOffset();
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/**
 * 本地时区 ISO 串：`2026-10-31T11:29:25.403+0800`（毫秒固定三位）。
 *
 * 这是**日志 / 事件 / 记录**类时间戳的唯一写法（规范见 `rule#datetime`）。
 * 必须 UTC 时不要用它的变体：字段名带 `utc` 后缀 + 注释写明原因（如跨机器排序）。
 */
export function localISOString(d: Date = new Date()): string {
    assertValid(d);
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    return `${date}T${time}.${String(d.getMilliseconds()).padStart(3, '0')}${localOffset(d)}`;
}

/**
 * 本地日期键 `YYYY-MM-DD`（按天分桶 / 节假日查表用）。
 *
 * 别用 `toISOString().slice(0, 10)`：那是 **UTC** 日期，东八区 0~8 点会差一天
 * （凌晨 1 点查到的还是昨天的节假日表）。
 */
export function localDateKey(d: Date = new Date()): string {
    assertValid(d);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * ISO 串 → epoch 毫秒（任意偏移 / `Z` 都认；**无偏移按本地**，与 `new Date()` 同口径）。
 * 非法串 → `NaN`（不抛：比较链路上抛会把整张表带崩，交给调用方判 `Number.isFinite`）。
 */
export function instantOf(iso: string): number {
    return Date.parse(iso);
}

/**
 * 两个 ISO 串按**时刻**比较（-1 / 0 / 1），用于排序 —— 别用 `<` 比串。
 *
 * 判据：串里偏移可能不同（历史数据 `Z`、新数据 `+0800`，DST 时区还会变），
 * 字典序只在「同一偏移 + 同一格式」时等于时间序（旧注释的假设，##483 起不成立）。
 *
 * 非法 / 空串：**恒排最后**（与任务表「未设置恒最后」同一口径，与升降序无关）。
 */
export function compareInstant(a: string, b: string): number {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    const okA = Number.isFinite(ta);
    const okB = Number.isFinite(tb);
    if (!okA || !okB) return okA === okB ? 0 : okA ? -1 : 1;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
}
