// tests/core/cost-windows.test.ts
// 🎯 具名时段表（diy 扩展层 `models.dev.diy.json` 的 `windows`）的形状、展开与摘要。
//
// 这一层是「时段」的**唯一登记处**：价逐 (provider, model) 登记（models.dev 实测同一 canonical
// 模型最多 78 个售卖者、30 种价 —— 批量套价必错），时段却是 vendor 级一张表。表若坏，代价是
// 「静默按错档收钱」，所以坏段的语义（丢段 + 出声）必须钉住。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ModelsDevDiyFileSchema, resolveWindow, windowSummary, WINDOW_ID_RE, type WindowDef } from "../../src/shared/cost-windows";

/** DeepSeek 官方峰段（两段，UTC）：01:00–04:00 与 06:00–10:00 */
const DS: WindowDef = {
    label: "peak",
    calendar: "CN-mon-fri-ex-holiday",
    ranges: [
        { start: "01:00:00Z", end: "04:00:00Z" },
        { start: "06:00:00Z", end: "10:00:00Z" },
    ],
};

describe("resolveWindow（一张表 → 多个时段窗）", () => {
    it("多段 → 多条窗；label/calendar 由表带下去（档里不重复写）", () => {
        expect(resolveWindow(DS, "ds-peak")).toEqual({
            windows: [
                { startMin: 60, endMin: 240, offsetMs: 0, calendar: "CN-mon-fri-ex-holiday", label: "peak" },
                { startMin: 360, endMin: 600, offsetMs: 0, calendar: "CN-mon-fri-ex-holiday", label: "peak" },
            ],
            issues: [],
        });
    });
    it("跨零点（end < start）原样保留 —— 判定语义在 matchUtcRange（`[start, 24h) ∪ [0, end)`）", () => {
        const r = resolveWindow({ ranges: [{ start: "22:00:00+08:00", end: "02:00:00+08:00" }] }, "night");
        expect(r.windows).toEqual([{ startMin: 22 * 60, endMin: 2 * 60, offsetMs: 8 * 3600_000 }]);
    });
    it("坏段：无偏移 / 两端偏移不一致 → **丢该段** + issue（好段照留，不拖死整张表）", () => {
        const r = resolveWindow(
            {
                label: "peak",
                ranges: [
                    { start: "01:00", end: "04:00" }, // 无偏移 = 歧义
                    { start: "06:00:00+08:00", end: "10:00:00Z" }, // 两端不一致
                    { start: "13:00:00Z", end: "14:00:00Z" },
                ],
            },
            "mixed",
        );
        expect(r.windows).toEqual([{ startMin: 13 * 60, endMin: 14 * 60, offsetMs: 0, label: "peak" }]);
        expect(r.issues).toHaveLength(2);
        expect(r.issues.join()).toContain("丢段");
    });
    it("全段都坏 → 有 issue 说明原因（不静默给空表）", () => {
        const r = resolveWindow({ ranges: [{ start: "x", end: "y" }] }, "bad");
        expect(r.windows).toEqual([]);
        expect(r.issues.join()).toContain("段 start/end 非法");
    });
});

describe("windowSummary（UI 下拉 / CLI 输出的人读摘要）", () => {
    it("多段 + 偏移 + 日历，一段不漏（摘要漏段 = 人以为只登记了一段）", () => {
        expect(windowSummary(DS)).toBe("01:00–04:00Z, 06:00–10:00Z · CN-mon-fri-ex-holiday");
    });
    it("无日历 → 只列段", () => {
        expect(windowSummary({ ranges: [{ start: "22:00:00+08:00", end: "02:00:00+08:00" }] })).toBe("22:00–02:00+08:00");
    });
    it("坏段标出来（让人看见问题，不是静默吞掉）：不可解析 → 原样；偏移不一致 → 标注", () => {
        expect(windowSummary({ ranges: [{ start: "01:00", end: "04:00:00+08:00" }] })).toBe("01:00→04:00:00+08:00");
        expect(windowSummary({ ranges: [{ start: "01:00:00+08:00", end: "04:00:00Z" }] })).toBe("01:00–04:00(偏移不一致)");
    });
});

describe("ModelsDevDiyFileSchema（扩展层写侧 schema）", () => {
    it("完整文件过；ranges 空数组 → 拒（一张时段表没有段 = 没意义）", () => {
        expect(ModelsDevDiyFileSchema.safeParse({ version: 1, windows: { w: DS } }).success).toBe(true);
        expect(ModelsDevDiyFileSchema.safeParse({ windows: { w: { ranges: [] } } }).success).toBe(false);
    });
    it("windows 缺省 → 空表（扩展层可以先只有 note，后加表）", () => {
        const p = ModelsDevDiyFileSchema.safeParse({ note: "先占位" });
        expect(p.success).toBe(true);
        if (p.success) expect(p.data.windows).toEqual({});
    });
});

describe("WINDOW_ID_RE（id 会被写进 YAML，禁冒号以免与限定名混）", () => {
    it("常见 slug 过；带 `custom:` 形状的 id 拒", () => {
        for (const ok of ["deepseek-peak", "ds.peak_1", "a"]) expect(WINDOW_ID_RE.test(ok)).toBe(true);
        for (const bad of ["custom:x", "-lead", "", "有空格"]) expect(WINDOW_ID_RE.test(bad)).toBe(false);
    });
});

describe("仓库内置的扩展层真文件（手写资产：typo 会静默变坏，故在这里把住）", () => {
    const readJson = (name: string) =>
        JSON.parse(readFileSync(new URL(`../../src/main/data/${name}`, import.meta.url), "utf-8")) as Record<string, unknown>;
    const diy = ModelsDevDiyFileSchema.parse(readJson("models.dev.diy.json"));
    const calendarIds = Object.keys((readJson("calendars.json")["calendars"] ?? {}) as Record<string, unknown>);

    it("整份过 schema，且 windows 非空（真源是 models.dev 不表达的东西，删空等于功能丢）", () => {
        expect(Object.keys(diy.windows).length).toBeGreaterThan(0);
    });
    it("每张表的每段都能展开（resolveWindow 零 issue）", () => {
        for (const [id, def] of Object.entries(diy.windows)) {
            const r = resolveWindow(def, id);
            expect(r.issues, `${id}: ${r.issues.join("; ")}`).toEqual([]);
            expect(r.windows).toHaveLength(def.ranges.length);
        }
    });
    it("引用的日历 id 都在 calendars.json 里（引用不存在的日历 = 该档永不命中）", () => {
        for (const [id, def] of Object.entries(diy.windows)) {
            if (def.calendar === undefined) continue;
            expect(calendarIds, `时段表 ${id} 引用了不存在的日历 ${def.calendar}`).toContain(def.calendar);
        }
    });
});
