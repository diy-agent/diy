// tests/core/calendars.test.ts
// 🎯 日历判定 + 时段档（utc-range）选价。
//
// 用**真实内置产物** `src/main/data/calendars.json`（不是手搓表）：调休补班表是这份设计的
// 全部理由，拿假数据测等于没测 —— 真实数据里 2026 国庆（周中假日）与 9/20（周日补班）都在。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatMinuteOfDay, formatOffset, isWorkdayById, matchUtcRange, parseTimeOfDay, type CalendarTable, type UtcRangeWindow } from "../../src/shared/calendars";
import { describeTiers, ModelCostSchema, ratesOf, type ModelCost } from "../../src/shared/usage";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLES: CalendarTable = (
    JSON.parse(readFileSync(join(HERE, "../../src/main/data/calendars.json"), "utf-8")) as { calendars: CalendarTable }
).calendars;

/** `01:00:00+08:00` + `04:00:00+08:00` → 运行时归一形状 */
const win = (start: string, end: string, calendar?: string, label?: string): UtcRangeWindow => {
    const s = parseTimeOfDay(start)!;
    const e = parseTimeOfDay(end)!;
    return { startMin: s.minutes, endMin: e.minutes, offsetMs: s.offsetMs, ...(calendar ? { calendar } : {}), ...(label ? { label } : {}) };
};

/** DeepSeek 形状：谷价 base + 峰价时段档（01:00–04:00 中国工作日） */
const DS_COST: ModelCost = {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    baseLabel: "off-peak",
    tiers: [{ when: { kind: "utc-range", ...win("01:00:00+08:00", "04:00:00+08:00", "CN-business-day", "peak") }, input: 0.5, output: 3, cacheRead: 0.1 }],
};

describe("parseTimeOfDay（ISO 8601 时刻 + 必填偏移）", () => {
    it("带偏移 → 当日分钟 + 偏移毫秒", () => {
        expect(parseTimeOfDay("01:00:00+08:00")).toEqual({ minutes: 60, offsetMs: 8 * 3600_000 });
        expect(parseTimeOfDay("23:30:00Z")).toEqual({ minutes: 1410, offsetMs: 0 });
        expect(parseTimeOfDay("00:30:00-05:00")).toEqual({ minutes: 30, offsetMs: -5 * 3600_000 });
    });

    it("**缺偏移 → null**（不默认本地时区：歧义就是静默错档）", () => {
        expect(parseTimeOfDay("01:00")).toBeNull();
        expect(parseTimeOfDay("01:00:00")).toBeNull();
        expect(parseTimeOfDay("25:00:00+08:00")).toBeNull();
        expect(parseTimeOfDay("01:60:00+08:00")).toBeNull();
    });
});

describe("isWorkdayById（workdays > holidays > base.days）", () => {
    it("周中的法定假日 → 非工作日（算法推不出，只能靠表）", () => {
        expect(isWorkdayById(TABLES, "CN-business-day", "2026-10-05", 1)).toBe(false); // 周一，国庆
    });

    it("周末的调休补班 → 工作日（同上）", () => {
        expect(isWorkdayById(TABLES, "CN-business-day", "2026-09-20", 7)).toBe(true); // 周日补班
    });

    it("普通周末 → 非工作日；普通周中 → 工作日", () => {
        expect(isWorkdayById(TABLES, "CN-business-day", "2026-09-13", 7)).toBe(false); // 普通周日
        expect(isWorkdayById(TABLES, "CN-business-day", "2026-10-10", 6)).toBe(true); // 周六**补班**（国庆调休）
        expect(isWorkdayById(TABLES, "CN-business-day", "2026-10-08", 4)).toBe(true); // 周四
    });

    it("超出 coverage（公告未发）→ 退化为纯周规则，不算错", () => {
        expect(isWorkdayById(TABLES, "CN-business-day", "2027-03-01", 1)).toBe(true); // 周一
        expect(isWorkdayById(TABLES, "CN-business-day", "2027-03-06", 6)).toBe(false); // 周六
    });

    it("引用不存在的日历 id → false（调用方告警，绝不静默当真）", () => {
        expect(isWorkdayById(TABLES, "no-such-calendar", "2026-10-08", 4)).toBe(false);
    });
});

describe("matchUtcRange（时段 + 日历）", () => {
    const at = (iso: string) => Date.parse(iso);

    it("时段内 + 工作日 → 命中；时段外 → 不命中", () => {
        expect(matchUtcRange(win("01:00:00+08:00", "04:00:00+08:00", "CN-business-day"), at("2026-10-08T02:00:00+08:00"), TABLES)).toBe(true);
        expect(matchUtcRange(win("01:00:00+08:00", "04:00:00+08:00", "CN-business-day"), at("2026-10-08T05:00:00+08:00"), TABLES)).toBe(false);
    });

    it("边界：start 闭、end 开", () => {
        const w = win("01:00:00+08:00", "04:00:00+08:00");
        expect(matchUtcRange(w, at("2026-10-08T01:00:00+08:00"), TABLES)).toBe(true);
        expect(matchUtcRange(w, at("2026-10-08T04:00:00+08:00"), TABLES)).toBe(false);
    });

    it("跨零点（22:00 → 02:00）：两侧都命中，03:00 不命中", () => {
        const w = win("22:00:00+08:00", "02:00:00+08:00");
        expect(matchUtcRange(w, at("2026-10-08T23:30:00+08:00"), TABLES)).toBe(true);
        expect(matchUtcRange(w, at("2026-10-08T01:00:00+08:00"), TABLES)).toBe(true);
        expect(matchUtcRange(w, at("2026-10-08T03:00:00+08:00"), TABLES)).toBe(false);
    });

    it("时段命中但日历判非工作日 → 不命中（国庆凌晨不算峰）", () => {
        expect(matchUtcRange(win("01:00:00+08:00", "04:00:00+08:00", "CN-business-day"), at("2026-10-05T02:00:00+08:00"), TABLES)).toBe(false);
    });

    it("无 calendar → 只看时段（每天都算）", () => {
        expect(matchUtcRange(win("01:00:00+08:00", "04:00:00+08:00"), at("2026-10-05T02:00:00+08:00"), TABLES)).toBe(true);
    });
});

describe("ratesOf 的时段价（与上下文阶梯两轴分离）", () => {
    const at = (iso: string) => Date.parse(iso);

    it("命中时段 → 用峰价；`window` 记时段名，`tier` 仍是 base（两轴分开）", () => {
        const r = ratesOf(DS_COST, 1000, at("2026-10-08T02:00:00+08:00"), TABLES)!;
        expect(r.input).toBe(0.5);
        expect(r.output).toBe(3);
        expect(r.window).toBe("peak");
        expect(r.tier).toBe("base");
    });

    it("未命中时段 → base 价 + `baseLabel`（off-peak）", () => {
        const r = ratesOf(DS_COST, 1000, at("2026-10-08T12:00:00+08:00"), TABLES)!;
        expect(r.input).toBe(0.15);
        expect(r.window).toBe("off-peak");
    });

    it("不传日历 → 时段档一律不参与（退 base 价，绝不猜）", () => {
        const r = ratesOf(DS_COST, 1000, at("2026-10-08T02:00:00+08:00"))!;
        expect(r.input).toBe(0.15);
    });

    it("**按序首个命中**（时段是分类不是阈值，两个窗不可比大小）", () => {
        const overlap: ModelCost = {
            input: 1,
            output: 1,
            tiers: [
                { when: { kind: "utc-range", ...win("00:30:00+08:00", "08:30:00+08:00", undefined, "cheap") }, input: 2, output: 2 },
                { when: { kind: "utc-range", ...win("01:00:00+08:00", "04:00:00+08:00", undefined, "peak") }, input: 9, output: 9 },
            ],
        };
        expect(ratesOf(overlap, 1, at("2026-10-08T02:00:00+08:00"), TABLES)!.input).toBe(2);
    });

    it("时段未命中时，上下文阶梯照常生效（两轴不互斥）", () => {
        const both: ModelCost = {
            input: 1,
            output: 1,
            tiers: [
                { when: { kind: "utc-range", ...win("01:00:00+08:00", "04:00:00+08:00", undefined, "peak") }, input: 5, output: 5 },
                { when: { kind: "context", size: 100_000 }, input: 9, output: 9 },
            ],
        };
        const r = ratesOf(both, 200_000, at("2026-10-08T12:00:00+08:00"), TABLES)!;
        expect(r.input).toBe(9);
        expect(r.tier).toBe("input>100000");
    });
});

describe("展示格式化（formatMinuteOfDay / formatOffset，与解析互逆）", () => {
    it("分钟 → HH:MM；偏移 → ±HH:MM（0 → Z）", () => {
        expect(formatMinuteOfDay(60)).toBe("01:00");
        expect(formatMinuteOfDay(1410)).toBe("23:30");
        expect(formatOffset(8 * 3600_000)).toBe("+08:00");
        expect(formatOffset(-5 * 3600_000)).toBe("-05:00");
        expect(formatOffset(5.5 * 3600_000)).toBe("+05:30");
        expect(formatOffset(0)).toBe("Z");
    });

    it("解析 ∘ 格式化 = 恒等（不是各写一套，改一处就漂）", () => {
        for (const s of ["01:00:00+08:00", "23:30:00Z", "00:30:00-05:00", "12:45:00+05:30"]) {
            const t = parseTimeOfDay(s)!;
            expect(parseTimeOfDay(`${formatMinuteOfDay(t.minutes)}:00${formatOffset(t.offsetMs)}`)).toEqual(t);
        }
    });
});

describe("describeTiers（分档价必须**看得见**，否则表里 0.15、实收 0.5）", () => {
    it("时段档 → 时段名 + 区间 + 日历 + 三个价", () => {
        expect(describeTiers(DS_COST)).toEqual(["peak（01:00–04:00 +08:00 · CN-business-day）：in 0.5 / out 3 / cache 0.1"]);
    });

    it("无日历 → 不写日历段；缺档名 → 占位（不冒用 baseLabel）", () => {
        const c: ModelCost = { input: 1, output: 2, baseLabel: "off-peak", tiers: [{ when: { kind: "utc-range", ...win("22:00:00+08:00", "02:00:00+08:00") }, input: 5, output: 6 }] };
        const [line] = describeTiers(c);
        expect(line).toContain("22:00–02:00 +08:00）：in 5 / out 6");
        expect(line).not.toContain("CN-business-day");
        expect(line).not.toContain("off-peak"); // 档名缺省 ≠ 基准名（冒用会让人把峰价当谷价）
    });

    it("上下文阶梯 → 阈值写法；无分档 → 空数组（UI 据此不画标记）", () => {
        expect(describeTiers({ input: 1, output: 2, tiers: [{ when: { kind: "context", size: 272_000 }, input: 2, output: 4 }] }))
            .toEqual(["总输入 > 272000 tokens：in 2 / out 4"]);
        expect(describeTiers({ input: 1, output: 2 })).toEqual([]);
        expect(describeTiers(null)).toEqual([]);
    });
});

describe("ModelCostSchema（下发给 UI/CLI 的形状；漏字段不会报错，只会静默看不见）", () => {
    it("解析运行时价目：含 baseLabel 与两种档（判别键 kind）", () => {
        const parsed = ModelCostSchema.parse({
            ...DS_COST,
            tiers: [...DS_COST.tiers!, { when: { kind: "context", size: 272_000 }, input: 0.2, output: 0.8 }],
        }) as ModelCost;
        expect(parsed.baseLabel).toBe("off-peak");
        expect(parsed.tiers!.map((t) => t.when.kind)).toEqual(["utc-range", "context"]);
        // 解析后仍可直接喂计价：schema 与 `ModelCost` 同构（不是"看起来像"）
        expect(ratesOf(parsed, 1000, Date.parse("2026-10-08T02:00:00+08:00"), TABLES)!.input).toBe(0.5);
    });

    it("拒收写侧形状（snake_case + `type`/`data`）—— 两套形状不能混", () => {
        const specShape = { input: 1, output: 2, tiers: [{ input: 5, output: 6, tier: { type: "context", size: 1 } }] };
        expect(ModelCostSchema.safeParse(specShape).success).toBe(false);
    });
});
