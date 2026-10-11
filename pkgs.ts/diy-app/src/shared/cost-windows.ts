// src/shared/cost-windows.ts
// 🎯 具名时段表（`src/main/data/models.dev.diy.json` 的 `windows`）：**一次定义、多处引用**的时段。
// 纯数据 + 纯函数，无 node 依赖（main 与 renderer 都引用）。
//
// 为什么要有它（时段表与「按时段的价」是两回事）：
//   · 日历（shared/calendars.ts）回答「**哪些日子**算数」，时段表回答「一天里的**哪几段**」。
//   · **价**必须逐 (provider, model) 登记：models.dev 实测同一 canonical 模型（如
//     `deepseek/deepseek-v4.1-flash`）有 78 个售卖者、30 种价 —— 按 family/canonical 批量套价必错。
//   · **时段**却是 vendor 级的同一张表（DeepSeek 全部模型共用一套峰谷，且是**两段**不相邻区间）。
//     逐模型手抄同一张表 = 抄漏一段就静默算错钱。故时段表抽出来按 id 共享，档里只写
//     `{window: "deepseek-peak"}` + 价。
//
// 为什么放 diy 扩展层而不是 models.dev：models.dev 全量实测（6026 模型 / 373 条 tiers）
// **零个**时间相关字段、tiers 清一色 `type:"context"` —— 时段计费上游根本不表达，只能自己登记。
//
// 与 tz 无关：段用带 UTC 偏移的 ISO 8601 时刻（`01:00:00Z` / `09:00:00+08:00`），偏移内嵌。
// 失败语义（承「不可测 ≠ 0」）：表里没这个 id / 段解析不出 → 该档**不命中**（退 base 价）+ 告警，
// 绝不静默按错档收钱。

import { z } from "zod";
import { formatMinuteOfDay, formatOffset, parseTimeOfDay, type UtcRangeWindow } from "./calendars";

/** 时段表 id：稳定 ASCII slug（落进 `providers.custom.yaml` / `model.yaml`，禁冒号以免与限定名混） */
export const WINDOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 一段（起止**闭开** `[start, end)`；`end < start` = 跨零点）；两端偏移必须一致 */
export const WindowRangeSchema = z.object({ start: z.string(), end: z.string() });

/**
 * 一张具名时段表：一个 `label` + 一个 `calendar` + **若干段**。
 * `ranges` 是数组（不是单段）—— DeepSeek 峰段就是 `01:00–04:00` **加** `06:00–10:00` 两段；
 * 单段形状逼着人拆成两张表，或漏抄一段。
 */
export const WindowDefSchema = z.object({
    /** 该时段落进 `rates.window` 的展示名（如 `"peak"`）；缺省沿用档的 `baseLabel` */
    label: z.string().optional(),
    /** 日历 id（`calendars.json`）；缺省 = 段内每天都算 */
    calendar: z.string().optional(),
    /** 出处/依据（人读；如官方价页原文那句 —— 免得后人不知数字哪来的） */
    note: z.string().optional(),
    ranges: z.array(WindowRangeSchema).min(1, "至少一段"),
});
export type WindowDef = z.infer<typeof WindowDefSchema>;

/** `models.dev.diy.json` 全文（diy 手写扩展层；只增不改，永不被上游覆盖） */
export const ModelsDevDiyFileSchema = z.object({
    version: z.number().optional(),
    /** 本文件是什么、为什么存在（人读；给未来的自己） */
    note: z.string().optional(),
    /** id → 时段表 */
    windows: z.record(z.string(), WindowDefSchema).default({}),
});
export type ModelsDevDiyFile = z.infer<typeof ModelsDevDiyFileSchema>;

/** 时段表 id → 定义（运行时由 main 读 `models.dev.diy.json` 灌入） */
export type WindowTable = Record<string, WindowDef>;

/**
 * 展开一张表为运行时时段窗（多段 → 多个窗）。
 * 段非法（缺偏移 / 两端偏移不一致）→ **丢该段**并记 issue（调用方告警），不抛错：
 * 一张表坏一段不该把整个模型目录拖死。
 */
export function resolveWindow(def: WindowDef, id: string): { windows: UtcRangeWindow[]; issues: string[] } {
    const windows: UtcRangeWindow[] = [];
    const issues: string[] = [];
    def.ranges.forEach((r, i) => {
        const s = parseTimeOfDay(r.start);
        const e = parseTimeOfDay(r.end);
        if (!s || !e) {
            issues.push(`时段表 ${id} 第 ${i + 1} 段 start/end 非法（须带 UTC 偏移，如 01:00:00Z）→ 丢段`);
            return;
        }
        if (s.offsetMs !== e.offsetMs) {
            issues.push(`时段表 ${id} 第 ${i + 1} 段两端偏移不一致 → 丢段（歧义不猜）`);
            return;
        }
        windows.push({
            startMin: s.minutes,
            endMin: e.minutes,
            offsetMs: s.offsetMs,
            ...(def.calendar ? { calendar: def.calendar } : {}),
            ...(def.label ? { label: def.label } : {}),
        });
    });
    if (windows.length === 0 && issues.length === 0) issues.push(`时段表 ${id} 没有可用段`);
    return { windows, issues };
}

/** 一张表的人读摘要（UI 下拉 / CLI 输出）：`01:00–04:00, 06:00–10:00Z · CN-mon-fri-ex-holiday` */
export function windowSummary(def: WindowDef): string {
    const segs = def.ranges
        .map((r) => {
            const s = parseTimeOfDay(r.start);
            const e = parseTimeOfDay(r.end);
            if (!s || !e) return `${r.start}→${r.end}`; // 非法段照原样显示（让人看见问题）
            const a = formatMinuteOfDay(s.minutes);
            const b = formatMinuteOfDay(e.minutes);
            // 两端偏移不一致：标出来（这里是**展示**，判定侧由 resolveWindow 丢段 —— 但摘要要让人看见坏在哪）
            return s.offsetMs === e.offsetMs ? `${a}–${b}${formatOffset(s.offsetMs)}` : `${a}–${b}(偏移不一致)`;
        })
        .join(", ");
    return def.calendar ? `${segs} · ${def.calendar}` : segs;
}
