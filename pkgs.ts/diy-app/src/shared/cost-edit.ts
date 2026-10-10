// src/shared/cost-edit.ts
// 🎯 价格登记的 **UI 编辑变换**（纯函数：无 DOM、无 node）—— ModelConfigPage 只渲染，逻辑在这层。
//
// 为什么独立成文件：renderer 组件测试要起 Electron（慢、脆），而这里全是**纯对象变换** →
// 单测可直接跑，且能顺手验证「UI 编出来的 cost 一定能过 zod」（产物合法性是本层的第一职责：
// 写侧 schema 严格，UI 产出非法值 → 保存时整卡报错，用户白填）。
//
// 范围：只编辑**时段档**（`utc-range`）。上下文阶梯（`context`）是 models.dev 原生形状，
// UI 不碰、按原位保留（见 `utcRangeSlots` 保留下标）。
import { parseTimeOfDay } from "./calendars";
import { TIME_OF_DAY_RE, type Cost, type CostTier } from "./model-config";

/** 可编辑的单价字段（spec 的 snake_case；单位 $/1M tokens） */
export type CostField = "input" | "output" | "cache_read" | "cache_write";
export const COST_FIELDS: readonly CostField[] = ["input", "output", "cache_read", "cache_write"];

/**
 * 「中国法定工作日」日历 id —— 内置 `calendars.json` 里**唯一带数据**的日历
 * （另一条 `weekend-sat-sun` 是纯周规则）。UI 的时段档只提供这一个日历可选：
 * 中国的「法定假日」与「周末调休补班」算法推不出（每年国务院公告），只能查表；
 * 其余地区/口径要加，就往 `calendars.json` 里加表，UI 自动跟着列出来（不写死）。
 */
export const CN_BUSINESS_DAY = "CN-business-day";

/** 一条时段档在 `cost.tiers` 里的**原始下标** + 条目（保下标 = 编辑按原位回写，不打乱既有顺序） */
export interface TierSlot {
    index: number;
    tier: CostTier;
}

/** 取出所有时段档（`utc-range`）；`context` 档与没写 `tier` 的条目**跳过但不丢**（仍在数组里） */
export function utcRangeSlots(cost: Cost | undefined): TierSlot[] {
    const out: TierSlot[] = [];
    (cost?.tiers ?? []).forEach((tier, index) => {
        if (tier.tier?.type === "utc-range") out.push({ index, tier });
    });
    return out;
}

/**
 * 新档模板：DeepSeek 峰段的形状（01:00–04:00 +08:00，中国工作日，label=peak），
 * **价格留空** —— 空价 = 沿用 base 价（`toModelCost` 的回退语义），用户按需填。
 */
export function newUtcRangeTier(): CostTier {
    return {
        tier: {
            type: "utc-range",
            data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: CN_BUSINESS_DAY, label: "peak" },
        },
    };
}

/** 追加一条时段档 → 返回新档的**下标**（UI 用它定位/展开） */
export function addUtcRangeTier(cost: Cost): number {
    const tiers = (cost.tiers ??= []);
    tiers.push(newUtcRangeTier());
    return tiers.length - 1;
}

/** 删一条档（按下标，任何类型都能删 —— 但 UI 只暴露给时段档） */
export function removeTier(cost: Cost, index: number): void {
    cost.tiers?.splice(index, 1);
    if (cost.tiers && cost.tiers.length === 0) delete cost.tiers;
}

/** `""` → 删字段（不写 0）；非法/负数 → 忽略（保持原值，不静默改成 0） */
function setNum(target: Record<string, unknown>, key: string, raw: string): void {
    const t = raw.trim();
    if (!t) {
        delete target[key];
        return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return;
    target[key] = n;
}

/** 写 base 档单价（清空 = 删字段；不看 `tiers`，`tiers` 由各自函数维护） */
export function setBasePrice(cost: Cost, f: CostField, raw: string): void {
    setNum(cost as unknown as Record<string, unknown>, f, raw);
}

/** 写 base 档展示名（如 `off-peak`）；清空 = 删（回退默认 "base"） */
export function setBaseLabel(cost: Cost, raw: string): void {
    const t = raw.trim();
    if (t) cost.baseLabel = t;
    else delete cost.baseLabel;
}

/** 单条时段档的编辑指令（只给要改的键；`calendar`/`label` 给空串 = 删该字段） */
export interface TierPatch {
    start?: string;
    end?: string;
    calendar?: string;
    label?: string;
    price?: { f: CostField; raw: string };
}

/** 改一条时段档（按下标；非 `utc-range` 档 → 原样不动，防误改 models.dev 原生条目） */
export function patchUtcRange(cost: Cost, index: number, patch: TierPatch): void {
    const tier = cost.tiers?.[index];
    if (!tier || tier.tier?.type !== "utc-range") return;
    const d = tier.tier.data;
    for (const k of ["start", "end"] as const) {
        const v = patch[k];
        if (v !== undefined) d[k] = v; // 必填字段：允许临时非法（URI 里标红提示，保存前由 zod 拦）
    }
    for (const k of ["calendar", "label"] as const) {
        const v = patch[k];
        if (v === undefined) continue;
        const t = v.trim();
        if (t) d[k] = t;
        else delete d[k];
    }
    if (patch.price) setNum(tier as unknown as Record<string, unknown>, patch.price.f, patch.price.raw);
}

/**
 * 单条时段档的**校验提示**（空数组 = 合法）。保存侧由 zod 兜底（会整卡报错），
 * 这里提前标红，省得用户填完才被打回。规则与 `TierWhenSchema` / runtime 语义一一对应。
 */
export function tierIssues(cost: Cost | undefined, tier: CostTier): string[] {
    const out: string[] = [];
    if (tier.tier?.type !== "utc-range") return out;
    const d = tier.tier.data;
    const s = parseTimeOfDay(d.start);
    const e = parseTimeOfDay(d.end);
    if (!TIME_OF_DAY_RE.test(d.start.trim())) out.push("开始时刻须带 UTC 偏移（如 01:00:00+08:00）");
    if (!TIME_OF_DAY_RE.test(d.end.trim())) out.push("结束时刻须带 UTC 偏移（同上）");
    if (s && e && s.offsetMs !== e.offsetMs) out.push("开始/结束的 UTC 偏移须一致（跨时区 = 歧义）");
    if (tier.input == null && tier.output == null && (cost?.input == null || cost.output == null)) {
        out.push("本档与默认档都没填完整价（in/out）→ 该时段仍算不出金额");
    }
    return out;
}
