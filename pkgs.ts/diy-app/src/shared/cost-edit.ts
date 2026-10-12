// src/shared/cost-edit.ts
// 🎯 价格登记的**编辑变换**（纯函数：无 DOM、无 node）—— UI（ModelConfigPage）与 CLI
// （`diy llmConfig setCost/setTiers` 的服务端实现）共用同一层，两边不各写一份。
//
// 为什么独立成文件：renderer 组件测试要起 Electron（慢、脆），而这里全是**纯对象变换** →
// 单测可直接跑，且能顺手验证「编辑出来的 cost 一定能过 zod」（产物合法性是本层的第一职责：
// 写侧 schema 严格，产出非法值 → 保存时整块报错/CLI 拒收，用户白填）。
//
// 范围：base 档（in/out/读/写 + `baseLabel`）与**时段档**（`utc-range`：具名时段表 `window`
// 或自定义时刻 `start`/`end` 二选一）。上下文阶梯（`context`）
// 是 models.dev 原生形状 —— 不编辑、按原位保留（见 `utcRangeSlots` 保留下标、`setUtcRangeTiers`
// 只动 utc-range 条目）。⚠️ 时段档的**顺序即优先级**（按序首个命中，见 usage.ratesOf）：
// 任何批量操作都不得打乱既有时段档的相对次序。
import { parseTimeOfDay } from "./calendars";
import { COST_PRICE_FIELDS, TIME_OF_DAY_RE, type Cost, type CostClearField, type CostPriceField, type CostTier } from "./model-config";

/** 可编辑的单价字段（spec 的 snake_case；单位 $/1M tokens）—— 字段集真源在 model-config */
export type CostField = CostPriceField;
export const COST_FIELDS: readonly CostField[] = COST_PRICE_FIELDS;

/** base 档可清字段（比 `CostField` 多一个展示名 `baseLabel`）—— 真源同上 */
export type { CostClearField };
export const COST_CLEAR_FIELDS: readonly CostClearField[] = [...COST_PRICE_FIELDS, "baseLabel"];

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
 * 新档模板（**自定义时刻**）：一个形状示例（01:00–04:00 +08:00，中国上班日，label=peak），
 * **价格留空** —— 空价 = 沿用 base 价（`toModelCost` 的回退语义），用户按需填。
 * 默认给"自定义"而不是某张具名表：表是 vendor 专属的（`deepseek-peak` 只对 DeepSeek 成立），
 * 给别的 provider 预选一张 DeepSeek 表 = 误导。
 */
/** 自定义时刻档的形状示例 —— **字面量类型常量**，勿经 `newUtcRangeTier(): CostTier` 的注解去取 `.data`：
 *  那注解会把判别键 `type` 抹平成联合（`context` 分支的 `data` 还可选），`start`/`end` 就成了
 *  「联合里某支没有的键 + 可能 undefined」，tsc 直接报一串（##281 review 实踩）。 */
const UTC_RANGE_TEMPLATE = {
    start: "01:00:00+08:00",
    end: "04:00:00+08:00",
    calendar: CN_BUSINESS_DAY,
    label: "peak",
} as const;

export function newUtcRangeTier(): CostTier {
    return { tier: { type: "utc-range", data: { ...UTC_RANGE_TEMPLATE } } };
}

/**
 * 新档模板（**具名时段表**）：只写表 id —— 段/日历/标签全在 diy 扩展层
 * （`models.dev.diy.json` 的 `windows`）定义，这里**不重复参数**。价格仍留空。
 */
export function newWindowTier(windowId: string): CostTier {
    return { tier: { type: "utc-range", data: { window: windowId } } };
}

/** 追加一条时段档 → 返回新档的**下标**（UI 用它定位/展开）；给了 `windowId` 则用具名时段表 */
export function addUtcRangeTier(cost: Cost, windowId?: string): number {
    const tiers = (cost.tiers ??= []);
    tiers.push(windowId ? newWindowTier(windowId) : newUtcRangeTier());
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

/**
 * **改价收尾**：编辑完若整个 `cost` 已空，就把 `cost` 键删掉 —— 不留 `cost: {}`。
 * 空壳在 YAML 里毫无意义却会误导阅读者（看着"配了价"、"其实没价"），也让「填了又清空」
 * 回不到初始态。UI 的**每个**编辑入口都包这层（填单价 / 改基准标签 / 增删时段档）。
 */
export function editCost(parent: { cost?: Cost }, fn: (cost: Cost) => void): void {
    const c = (parent.cost ??= {});
    fn(c);
    if (Object.keys(c).length === 0) delete parent.cost;
}

/** 单条时段档的编辑指令（只给要改的键；`calendar`/`label` 给空串 = 删该字段） */
export interface TierPatch {
    /** 切到具名时段表 id；空串 = 切回**自定义时刻**（按模板填 start/end） */
    window?: string;
    start?: string;
    end?: string;
    calendar?: string;
    label?: string;
    price?: { f: CostField; raw: string };
}

/**
 * 改一条时段档（按下标；非 `utc-range` 档 → 原样不动，防误改 models.dev 原生条目）。
 *
 * **两种模式的互斥由本函数维护**（写侧 zod 也会拒"window 与 start 同时给"，但那会让整份
 * YAML 存不下去 —— 不能指望它兜底）：
 *   · `patch.window` 给了 → 只留 `window`，清掉 `start`/`end`/`calendar`/`label`
 *   · `patch.start/end/calendar/label` 给了 → 视为**自定义时刻**，先清掉 `window`
 */
export function patchUtcRange(cost: Cost, index: number, patch: TierPatch): void {
    const tier = cost.tiers?.[index];
    if (!tier || tier.tier?.type !== "utc-range") return;
    const d = tier.tier.data;
    // ① 显式切换模式
    if (patch.window !== undefined) {
        const t = patch.window.trim();
        if (t) {
            d.window = t;
            for (const k of ["start", "end", "calendar", "label"] as const) delete d[k];
        } else {
            delete d.window;
            Object.assign(d, UTC_RANGE_TEMPLATE); // 切回自定义：给形状示例，免留空档存不下
        }
    }
    // ② 改「自定义模式专属字段」= 隐式切回自定义（否则 window 与 start 并存 → zod 拒整份 YAML）
    if ((["start", "end", "calendar", "label"] as const).some((k) => patch[k] !== undefined) && d.window !== undefined) {
        delete d.window;
        d.start ??= UTC_RANGE_TEMPLATE.start;
        d.end ??= UTC_RANGE_TEMPLATE.end;
    }
    // ③ 具名模式：段/日历/标签由时段表定义，此处只动价
    if (d.window === undefined) {
        d.start ??= ""; // 自定义模式下 start/end 是必填：先保证键在（值可临时非法，UI 标红、zod 兜底）
        d.end ??= "";
        for (const k of ["start", "end"] as const) {
            const v = patch[k];
            if (v !== undefined) d[k] = v;
        }
        for (const k of ["calendar", "label"] as const) {
            const v = patch[k];
            if (v === undefined) continue;
            const t = v.trim();
            if (t) d[k] = t;
            else delete d[k];
        }
    }
    if (patch.price) setNum(tier as unknown as Record<string, unknown>, patch.price.f, patch.price.raw);
}

/**
 * 单条时段档的**校验提示**（空数组 = 合法）。保存侧由 zod 兜底（会整卡报错），
 * 这里提前标红，省得用户填完才被打回。规则与 `TierWhenSchema` / runtime 语义一一对应。
 *
 * `calendarIds` / `windowIds` 给了才查「引用的日历 / 时段表是否存在」（UI 下拉只列已存在的，
 * 故不传；CLI 用回执的 `warnings` 报给 agent —— 引用不存在的 id 不阻断保存，只让该档永不命中，
 * 见 shared/calendars.ts 与 shared/cost-windows.ts）。
 */
export function tierIssues(
    cost: Cost | undefined,
    tier: CostTier,
    calendarIds?: readonly string[],
    windowIds?: readonly string[],
): string[] {
    const out: string[] = [];
    if (tier.tier?.type !== "utc-range") return out;
    const d = tier.tier.data;
    if (d.window !== undefined) {
        // 具名时段表模式：段/日历/标签都在表里，这里只查「表是否存在」+ 价
        if (windowIds && !windowIds.includes(d.window)) {
            out.push(`引用时段表 ${d.window} 不存在（该档永不命中，退 base 价）`);
        }
    } else {
        const start = d.start ?? "";
        const end = d.end ?? "";
        const s = parseTimeOfDay(start);
        const e = parseTimeOfDay(end);
        if (!TIME_OF_DAY_RE.test(start.trim())) out.push("开始时刻须带 UTC 偏移（如 01:00:00+08:00）");
        if (!TIME_OF_DAY_RE.test(end.trim())) out.push("结束时刻须带 UTC 偏移（同上）");
        if (s && e && s.offsetMs !== e.offsetMs) out.push("开始/结束的 UTC 偏移须一致（跨时区 = 歧义）");
        if (calendarIds && d.calendar !== undefined && !calendarIds.includes(d.calendar)) {
            out.push(`引用日历 ${d.calendar} 不存在（该时段永不命中，退 base 价）`);
        }
    }
    if (tier.input == null && tier.output == null && (cost?.input == null || cost.output == null)) {
        out.push("本档与默认档都没填完整价（in/out）→ 该时段仍算不出金额");
    }
    return out;
}

// ── CLI 侧（`llmConfig setCost/setTiers`）用的批量变换 + 回执预警 ──

/** 单价补丁：**合并语义** —— 只改给出的键，未给的一律保持（CLI 每次只传想改的） */
export interface CostPatch {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    /** 空串 = 删字段（回退默认 "base"） */
    baseLabel?: string;
    /** 显式清字段（CLI `--clear-fields`；与上面同名的以清为准） */
    clearFields?: readonly CostClearField[];
}

/** 应用补丁（就改传入对象；`tiers` 不在此列，见 `setUtcRangeTiers`） */
export function applyCostPatch(cost: Cost, patch: CostPatch): void {
    for (const f of COST_FIELDS) {
        const v = patch[f];
        if (v !== undefined) cost[f] = v;
    }
    if (patch.baseLabel !== undefined) setBaseLabel(cost, patch.baseLabel);
    for (const f of patch.clearFields ?? []) {
        if (f === "baseLabel") delete cost.baseLabel;
        else delete cost[f];
    }
}

/** 空价目（无任何单价、无标签、无档）→ 调用方应把整个 `cost` 键删掉，不留 `cost: {}` 噪声 */
export function isEmptyCost(cost: Cost | undefined): boolean {
    if (!cost) return true;
    if (cost.input !== undefined || cost.output !== undefined) return false;
    if (cost.cache_read !== undefined || cost.cache_write !== undefined) return false;
    if (cost.baseLabel) return false;
    return (cost.tiers?.length ?? 0) === 0;
}

/** 时段档条数（CLI `--drop <n>` / 回执 `tierCount` 的编号口径：**只数 utc-range**） */
export function utcRangeCount(cost: Cost | undefined): number {
    return (cost?.tiers ?? []).filter((t) => t.tier?.type === "utc-range").length;
}

/**
 * 批量写时段档：`replace` = 换掉**全部** utc-range 档（新档落在原首条的位置，既有时段档次序
 * 之外的条目 —— 尤其 models.dev 的 context 档 —— 原位保留）；`append` = 追加到末尾。
 * 档位顺序 = 优先级，故 replace 时**只能整段换**，不能逐条覆盖导致次序错乱。
 */
export function setUtcRangeTiers(cost: Cost, tiers: readonly CostTier[], mode: "replace" | "append"): void {
    const incoming = tiers.map((t) => structuredClone(t)) as CostTier[];
    if (mode === "append") {
        if (incoming.length === 0) return;
        (cost.tiers ??= []).push(...incoming);
        return;
    }
    const all = cost.tiers ?? [];
    const kept = all.filter((t) => t.tier?.type !== "utc-range");
    const firstIdx = all.findIndex((t) => t.tier?.type === "utc-range");
    // 插入点 = 原首条时段档之前**被保留下来**的条目数（= 它在 kept 里的下标）
    const insertAt = firstIdx < 0 ? kept.length : all.slice(0, firstIdx).filter((t) => t.tier?.type !== "utc-range").length;
    const next = [...kept.slice(0, insertAt), ...incoming, ...kept.slice(insertAt)];
    if (next.length === 0) delete cost.tiers;
    else cost.tiers = next;
}

/** 删第 n 条时段档（0-based，只数 utc-range）；越界 → null（调用方报错，别静默无操作） */
export function dropUtcRangeTier(cost: Cost, n: number): CostTier | null {
    const slot = utcRangeSlots(cost)[n];
    if (!slot) return null;
    const removed = (cost.tiers ?? []).splice(slot.index, 1)[0] ?? null;
    if (cost.tiers?.length === 0) delete cost.tiers;
    return removed;
}

/** 删光全部时段档（保留 context 档）；返回删掉的条数 */
export function clearUtcRangeTiers(cost: Cost): number {
    const all = cost.tiers ?? [];
    const kept = all.filter((t) => t.tier?.type !== "utc-range");
    const removed = all.length - kept.length;
    if (kept.length === 0) delete cost.tiers;
    else cost.tiers = kept;
    return removed;
}

/**
 * 价目**预警**（不阻断保存；CLI 写后回执给 agent，UI 侧另有 `tierIssues` 就地标红）。
 * 判据与运行时一致 —— 预警的每一条都对应「这个价会在某类请求上算不出/算错」。
 */
export function costWarnings(
    cost: Cost | undefined,
    calendarIds: readonly string[],
    windowIds: readonly string[] = [],
): string[] {
    if (isEmptyCost(cost)) return ["无价目 → usage 金额为 null（不是 0；不是免费）"];
    const out: string[] = [];
    const c = cost!;
    if (c.input === undefined || c.output === undefined) {
        out.push("base 档缺完整价（in/out）→ 未命中时段档的请求算不出金额");
    }
    const raw = c.tiers ?? [];
    raw.forEach((t, i) => {
        if (!t.tier) out.push(`tiers[${i}] 缺 tier 触发条件（运行时忽略该条）`);
    });
    utcRangeSlots(c).forEach((slot, n) => {
        for (const msg of tierIssues(c, slot.tier, calendarIds, windowIds)) out.push(`第 ${n} 条时段档: ${msg}`);
    });
    return out;
}
