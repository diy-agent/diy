// src/main/core/calendars.ts
// 🎯 内置日历表（`src/main/data/calendars.json`）的加载：进程内缓存一次。
//
// 失败语义（承 shared/calendars.ts）：**加载失败 = 空表**（不抛错锁死启动），
// 后果是「引用了日历的时段档一律不命中 → 退到 base 价」——宁可算 base 价（可解释），
// 不可静默按错的峰价收钱。启动/装配时把空表告警打出来。
import { readFileSync } from "node:fs";
import type { CalendarTable } from "../../shared/calendars";
import { dataFile } from "./data-file";

let _calendars: CalendarTable | null = null;

/** 内置日历表（id → 定义）；文件缺失/损坏 → `{}`（并告警一次） */
export function calendars(): CalendarTable {
    if (_calendars) return _calendars;
    const p = dataFile("calendars.json");
    if (!p) {
        console.warn("calendars.json 缺失 → 时段档的日历判定一律不命中（退 base 价）");
        return (_calendars = {});
    }
    try {
        const raw = JSON.parse(readFileSync(p, "utf-8")) as { calendars?: CalendarTable };
        _calendars = raw.calendars ?? {};
    } catch (e) {
        console.warn(`calendars.json 解析失败 → 时段档退 base 价: ${e instanceof Error ? e.message : String(e)}`);
        _calendars = {};
    }
    return _calendars;
}
