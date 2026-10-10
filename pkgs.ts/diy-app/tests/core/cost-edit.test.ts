// tests/core/cost-edit.test.ts
// 🎯 价格登记的 UI 编辑变换（shared/cost-edit.ts）。
//
// 这一层的**第一职责是产出合法配置**：写侧 schema 严格（zod 拒非法时刻/偏移），UI 若编出
// 非法值，保存时整卡报错、用户白填。所以最后一条用例把「编辑后产物」直接丢给 zod 校验。
import { describe, expect, it } from "vitest";
import { CostSchema, type Cost, type CostTier } from "../../src/shared/model-config";
import {
    CN_BUSINESS_DAY,
    addUtcRangeTier,
    applyCostPatch,
    clearUtcRangeTiers,
    costWarnings,
    dropUtcRangeTier,
    isEmptyCost,
    patchUtcRange,
    removeTier,
    setBaseLabel,
    setBasePrice,
    setUtcRangeTiers,
    tierIssues,
    utcRangeCount,
    utcRangeSlots,
} from "../../src/shared/cost-edit";

/** DeepSeek 形状：谷价 base（+off-peak 标签）+ 峰价时段档 */
const dsCost = (): Cost => ({
    input: 0.15,
    output: 0.6,
    cache_read: 0.003,
    baseLabel: "off-peak",
    tiers: [{ input: 0.5, output: 3, tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: CN_BUSINESS_DAY, label: "peak" } } }],
});

describe("setBasePrice（base 档单价）", () => {
    it("填值 → 数字落字段", () => {
        const c: Cost = {};
        setBasePrice(c, "input", " 1.25 ");
        expect(c.input).toBe(1.25);
    });
    it("清空 → 删字段（不留 0；「无价 ≠ 0」）", () => {
        const c: Cost = { input: 1, output: 2 };
        setBasePrice(c, "input", "");
        expect("input" in c).toBe(false);
        expect(c.output).toBe(2);
    });
    it("非法/负数 → 忽略（保持原值，不静默改成 0）", () => {
        const c: Cost = { input: 1 };
        setBasePrice(c, "input", "abc");
        setBasePrice(c, "input", "-3");
        expect(c.input).toBe(1);
    });
});

describe("setBaseLabel（未命中时段的档名）", () => {
    it("填 → 落字段；清空 → 删（回退默认 base）", () => {
        const c: Cost = {};
        setBaseLabel(c, "off-peak");
        expect(c.baseLabel).toBe("off-peak");
        setBaseLabel(c, "  ");
        expect("baseLabel" in c).toBe(false);
    });
});

describe("utcRangeSlots（保下标）", () => {
    it("跳过 context 档但**保留原始下标**（编辑按原位回写，不打乱 models.dev 原生档）", () => {
        const c: Cost = {
            input: 1,
            output: 2,
            tiers: [
                { input: 9, output: 9, tier: { type: "context", size: 272000 } },
                { input: 5, output: 6, tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00" } } },
                { input: 3, output: 4 }, // 无 tier：models.dev 允许，原样保留
            ],
        };
        const slots = utcRangeSlots(c);
        expect(slots.map((s) => s.index)).toEqual([1]);
        expect(slots[0]!.tier.input).toBe(5);
    });
    it("无 cost / 无 tiers → 空数组", () => {
        expect(utcRangeSlots(undefined)).toEqual([]);
        expect(utcRangeSlots({ input: 1, output: 2 })).toEqual([]);
    });
});

describe("addUtcRangeTier（新增档）", () => {
    it("追加到末尾并返回下标；模板 = 中国工作日 01:00–04:00 +08:00，价格留空", () => {
        const c: Cost = { input: 1, output: 2 };
        const i = addUtcRangeTier(c);
        expect(i).toBe(0);
        expect(c.tiers).toHaveLength(1);
        const t = c.tiers![0]!;
        expect(t.tier).toEqual({ type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: CN_BUSINESS_DAY, label: "peak" } });
        expect(t.input).toBeUndefined(); // 空价 = 沿用 base 价
    });
    it("已有档 → 追加在末尾（顺序 = 优先级）", () => {
        const c = dsCost();
        expect(addUtcRangeTier(c)).toBe(1);
        expect(c.tiers).toHaveLength(2);
    });
});

describe("patchUtcRange（改档）", () => {
    it("改时刻 / 改价 / 改标签", () => {
        const c = dsCost();
        patchUtcRange(c, 0, { start: "09:00:00+08:00", end: "12:30:00+08:00", label: "day", price: { f: "output", raw: "7.5" } });
        const w = c.tiers![0]!;
        expect(w.input).toBe(0.5); // 未动
        expect(w.output).toBe(7.5);
        expect(w.tier).toMatchObject({ type: "utc-range", data: { start: "09:00:00+08:00", end: "12:30:00+08:00", label: "day" } });
    });
    it("日历/标签清空 → 删字段（不限日历 = 每天都算）", () => {
        const c = dsCost();
        patchUtcRange(c, 0, { calendar: "", label: "   " });
        const d = (c.tiers![0]!.tier as { data: Record<string, unknown> }).data;
        expect("calendar" in d).toBe(false);
        expect("label" in d).toBe(false);
    });
    it("价格清空 → 删字段（回退 base，不是 0）", () => {
        const c = dsCost();
        patchUtcRange(c, 0, { price: { f: "input", raw: "" } });
        expect("input" in c.tiers![0]!).toBe(false);
    });
    it("下标指向 context 档 → 原样不动（UI 不该误改 models.dev 原生条目）", () => {
        const c: Cost = { input: 1, output: 2, tiers: [{ input: 9, output: 9, tier: { type: "context", size: 1000 } }] };
        patchUtcRange(c, 0, { start: "00:00:00Z" });
        expect(c.tiers![0]!.tier).toEqual({ type: "context", size: 1000 });
    });
    it("越界下标 → 不炸", () => {
        const c = dsCost();
        patchUtcRange(c, 5, { start: "00:00:00Z" });
        expect(c.tiers).toHaveLength(1);
    });
});

describe("removeTier", () => {
    it("删末档 → 连空数组字段一起删（不留 `tiers: []`）", () => {
        const c = dsCost();
        removeTier(c, 0);
        expect("tiers" in c).toBe(false);
    });
    it("删其中一档 → 其余原位保留", () => {
        const c = dsCost();
        addUtcRangeTier(c);
        removeTier(c, 0);
        expect(c.tiers).toHaveLength(1);
        expect(c.tiers![0]!.tier).toMatchObject({ data: { start: "01:00:00+08:00" } });
    });
});

describe("tierIssues（保存前标红；保存侧由 zod 兜底）", () => {
    it("合法档 → 无提示", () => {
        expect(tierIssues(dsCost(), dsCost().tiers![0]!)).toEqual([]);
    });
    it("缺 UTC 偏移 → 提示（歧义不猜）", () => {
        const t: CostTier = { tier: { type: "utc-range", data: { start: "01:00:00", end: "04:00:00+08:00" } } };
        expect(tierIssues(dsCost(), t).join()).toContain("开始时刻须带 UTC 偏移");
    });
    it("两端偏移不一致 → 提示", () => {
        const t: CostTier = { tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00Z" } } };
        expect(tierIssues(dsCost(), t).join()).toContain("偏移须一致");
    });
    it("本档与默认档都没填完整价 → 提示（否则该时段算不出金额）", () => {
        const t: CostTier = { tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00" } } };
        expect(tierIssues({}, t).join()).toContain("算不出金额");
        expect(tierIssues({ input: 1, output: 2 }, t)).toEqual([]); // 有默认价 → 档内价格可留空
    });
});

describe("编辑产物必须过写侧 schema", () => {
    it("新建档 → 改时刻/日历/价 → 仍能过 CostSchema（合法才能保存）", () => {
        const c: Cost = {};
        setBasePrice(c, "input", "0.15");
        setBasePrice(c, "output", "0.6");
        setBasePrice(c, "cache_read", "0.003");
        setBaseLabel(c, "off-peak");
        const i = addUtcRangeTier(c);
        patchUtcRange(c, i, { label: "peak", price: { f: "input", raw: "0.5" } });
        patchUtcRange(c, i, { price: { f: "output", raw: "3" } });
        const parsed = CostSchema.safeParse(c);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        if (parsed.success) expect(parsed.data.tiers![0]!.tier).toMatchObject({ type: "utc-range", data: { calendar: CN_BUSINESS_DAY } });
    });
});

// ── CLI 侧（`llmConfig setCost/setTiers`）共用的批量变换 ──

const ctxTier = (): CostTier => ({ input: 1, output: 6, tier: { type: "context", data: { size: 128000 } } });

describe("applyCostPatch（CLI 的合并语义）", () => {
    it("只改给出的键；clearFields 删指定字段（含 baseLabel）", () => {
        const c: Cost = { input: 1, output: 2, cache_read: 0.1, baseLabel: "off-peak" };
        applyCostPatch(c, { output: 9, clearFields: ["cache_read", "baseLabel"] });
        expect(c).toEqual({ input: 1, output: 9 });
    });
    it("baseLabel 空串 = 删（回退默认 base）", () => {
        const c: Cost = { input: 1, baseLabel: "peak" };
        applyCostPatch(c, { baseLabel: "  " });
        expect("baseLabel" in c).toBe(false);
    });
});

describe("isEmptyCost（空块不留噪声）", () => {
    it("无价无标签无档 = 空；只有标签或有档 = 不空", () => {
        expect(isEmptyCost({})).toBe(true);
        expect(isEmptyCost(undefined)).toBe(true);
        expect(isEmptyCost({ input: 0 })).toBe(false); // 0 是合法价（免费 ≠ 无价），别当空
        expect(isEmptyCost({ baseLabel: "off-peak" })).toBe(false);
        expect(isEmptyCost({ tiers: [ctxTier()] })).toBe(false);
    });
});

describe("setUtcRangeTiers（档位顺序 = 优先级，替换只能整段换）", () => {
    it("replace：context 档原位保留，新时段档落在原首条时段档的位置", () => {
        const c: Cost = { input: 1, output: 2, tiers: [dsCost().tiers![0]!, ctxTier()] };
        setUtcRangeTiers(c, [{ output: 99, tier: { type: "utc-range", data: { start: "05:00:00+08:00", end: "06:00:00+08:00" } } }], "replace");
        expect(c.tiers!.map((t) => t.tier?.type)).toEqual(["utc-range", "context"]);
        expect(c.tiers![0]!.output).toBe(99);
        expect(utcRangeCount(c)).toBe(1);
    });
    it("原本没有时段档 → 追加到末尾（不插到 context 之前）", () => {
        const c: Cost = { tiers: [ctxTier()] };
        setUtcRangeTiers(c, [dsCost().tiers![0]!], "replace");
        expect(c.tiers!.map((t) => t.tier?.type)).toEqual(["context", "utc-range"]);
    });
    it("append：追加在末尾；空数组无副作用", () => {
        const c: Cost = { tiers: [dsCost().tiers![0]!] };
        setUtcRangeTiers(c, [ctxTier()], "append");
        expect(c.tiers!.map((t) => t.tier?.type)).toEqual(["utc-range", "context"]);
        const n = c.tiers!.length;
        setUtcRangeTiers(c, [], "append");
        expect(c.tiers).toHaveLength(n);
    });
    it("入参深拷贝：改外部数组不影响已写入的档", () => {
        const c: Cost = {};
        const incoming: CostTier = { tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00" } } };
        setUtcRangeTiers(c, [incoming], "replace");
        incoming.output = 7;
        expect(c.tiers![0]!.output).toBeUndefined();
    });
});

describe("dropUtcRangeTier / clearUtcRangeTiers（编号只数 utc-range）", () => {
    it("drop(0) 删第一条时段档，context 档不受影响；越界 → null", () => {
        const c: Cost = { tiers: [ctxTier(), dsCost().tiers![0]!] };
        expect(dropUtcRangeTier(c, 1)).toBeNull();
        expect(dropUtcRangeTier(c, 0)).not.toBeNull();
        expect(c.tiers!.map((t) => t.tier?.type)).toEqual(["context"]);
    });
    it("clear 删光时段档、返回条数；无档时返回 0", () => {
        const c: Cost = { tiers: [dsCost().tiers![0]!, ctxTier()] };
        expect(clearUtcRangeTiers(c)).toBe(1);
        expect(clearUtcRangeTiers(c)).toBe(0);
        expect(c.tiers!.map((t) => t.tier?.type)).toEqual(["context"]);
    });
});

describe("costWarnings（CLI 回执的预警；与运行时判据一致）", () => {
    it("合法价目（base 全 + 档引用内置日历）→ 无预警", () => {
        expect(costWarnings(dsCost(), [CN_BUSINESS_DAY])).toEqual([]);
    });
    it("无价 → 明说金额为 null（不是 0）", () => {
        expect(costWarnings(undefined, []).join()).toContain("金额为 null");
        expect(costWarnings({}, []).join()).toContain("金额为 null");
    });
    it("缺 base in/out、坏时刻、不存在的日历、缺 tier 的条目 → 逐条点出（带序号）", () => {
        const c: Cost = {
            tiers: [
                { input: 1, output: 2, tier: { type: "utc-range", data: { start: "01:00:00", end: "04:00:00+08:00", calendar: "Mars" } } },
                { input: 1, output: 2 }, // 缺触发条件（运行时忽略）
            ],
        };
        const w = costWarnings(c, [CN_BUSINESS_DAY]);
        expect(w.join("\n")).toContain("base 档缺完整价");
        expect(w.join("\n")).toContain("第 0 条时段档: 开始时刻须带 UTC 偏移");
        expect(w.join("\n")).toContain("引用日历 Mars 不存在");
        expect(w.join("\n")).toContain("tiers[1] 缺 tier 触发条件");
    });
});
