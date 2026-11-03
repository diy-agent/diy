// src/shared/usage-fields.ts
// 🎯 用量**字段契约 + 列定义 + 聚合**（唯一真源；渲染层只格式化，不再各表手写 `<th>`）。
//
// 为什么单独一个文件（##443 刀 2）：
//   · 同一批数字现在有 5 处表格各写一套表头（逐条盘点见任务 body「刀 1 定稿」§三），
//     字段名/口径/可聚合性散落在 renderer；这里把它压成**一份** `USAGE_FIELDS` +
//     一处 `aggregateUsage()`，四级粒度（step / turn / persona / session）共用。
//   · 必须以纯函数存在：主进程（CLI 报表）、渲染层（表格）、单测三处共用同一份口径
//     —— 与 `shared/usage.ts` 同一条理由（##227：UI 与后台数字对不上，根因就是两处各算各的）。
//   · **禁止 import node:\***（renderer 会打进包）。
//
// ── 列清单来源（别自己加列）──
// 任务 body「刀 1 定稿（第四轮）」§三 的 22 行表。表里一行有时不止一个字段
// （如「速度 / ⚡ / ⌀」= `rate`/`turnRate`/`sessionRate`，「cost.*（6 项）」= 6 个键），
// 展开后共 **44 个 spec**；顺序与表一致，UI 直接 `<For each={USAGE_FIELDS}>` 即可。
//
// ── 七种聚合（`AggKind`）的语义（**改动前先读这里**）──
//   sum            逐步求和；**一步都没有数值 → null**（不是 0）
//   sum-with-null  逐步求和，但**全组都不可测 → null**（缓存写：null ≠ 0，##211 §五.5）
//   recompute      先聚合分子分母，再算派生量（缓存命中率、各类占比）——**不许平均比率**
//   last-step      取该组**最后一步**的值（窗口占用/上限：加和 = 40 步累加成 1M 的假象）
//   count          计数（步数、无价目步数）；可用 `test` 限定条件
//   set            去重集合（模型/面/档位/单价）；**单值退化为标量**，多值才是数组
//   none           不聚合：给了 `compute` 就用它，否则**仅 step 粒度有值、高层为 null**
//
// 空值语义：`null` = 不可测 / 不可得 / 不适用；`0` = 实测为零。两者在 `fmtCell` 里字形不同
// （null → `–`），任何一处退化成 `0` 都算 bug（单测锁死）。
//
// ── 已知边界（刀 3 注入，不在此造假数）──
// `compactEvents` / `compactRetainTokens` / `compactWindowTokens` 的**数据源是
// `compact.jsonl`（事件账）+ `turns.jsonl`（边界），不在 `usage.jsonl` 里** ——
// 本文件只声明列（UI 列序/粒度不变），值恒 `null`；刀 3 从事件账算出后**覆盖**这三列。
// （`deliveryCompact` 不在此列：它来自 `usage.historySelection`，是账内真值。）

import {
    avgRate,
    cacheHitRate,
    fmtCost,
    fmtInt,
    fmtRate,
    fmtTokens,
    stepRate,
    stepView,
    sumBuckets,
    sumCosts,
    type CostBreakdown,
    type StepUsageRecord,
    type StepView,
    type UsageBuckets,
} from "./usage";

/** 粒度：一行是什么 */
export type Gran = "step" | "turn" | "persona" | "session";

/** 聚合方式（语义见文件头；测试逐条锁） */
export type AggKind = "sum" | "sum-with-null" | "recompute" | "last-step" | "count" | "set" | "none";

/** 字形（渲染层只调 `fmtCell`，不各写一套） */
export type FieldFmt = "text" | "int" | "token" | "money" | "pct" | "ms" | "rate" | "datetime";

/** 单元格值：`null` = 不可测/不适用；数组 = 多值集合（`set`） */
export type FieldValue = number | string | readonly string[] | null;

/** 一步（记录 + 已还原的桶/金额/窗口） */
export interface StepContext {
    record: StepUsageRecord;
    view: StepView;
}

/** 一个聚合组（四级中任意一级的一行） */
export interface UsageBucket {
    /** 组键（step = `turnId#step`；turn = turnId；persona = 人物；session = 会话） */
    key: string;
    /** 组内步（**按 step 升序**；`first` / `last` 都以它为准） */
    steps: readonly StepUsageRecord[];
    views: readonly StepView[];
    /** 逐步上下文（`{record,view}` 复用同一个对象：44 列 × N 步不再各分配一次） */
    ctxs: readonly StepContext[];
    /** 桶求和（与 `sumBuckets` 同口径） */
    buckets: UsageBuckets;
    /** 金额求和；全组无价目 → null */
    cost: CostBreakdown | null;
    /** 无价目的步数（>0 ⇒ 金额是部分和，渲染层要标） */
    unpriced: number;
    first: StepView;
    last: StepView;
}

/** 一列（字段）的声明 */
export interface UsageFieldSpec {
    /** 字段键（UI 的列 key，`row.fields[key]`） */
    key: string;
    /** 列名（唯一一处中文名，表头直接取） */
    label: string;
    /** 适用粒度：表 = 本表按粒度过滤（`gran.includes(g)`） */
    gran: readonly Gran[];
    agg: AggKind;
    fmt: FieldFmt;
    /** hover 说明（口径 / 来源） */
    hint?: string;
    /** 列宽（px，可选；渲染层可覆盖） */
    width?: number;
    /** 逐步取值 */
    pick?: (s: StepContext) => FieldValue;
    /** `count` 的计数条件（缺省 = 每步都算 1） */
    test?: (s: StepContext) => boolean;
    /** `recompute` / `none` 的派生实现 */
    compute?: (b: UsageBucket, gran: Gran) => FieldValue;
}

/** 聚合结果的一行 */
export interface UsageRow {
    gran: Gran;
    key: string;
    /** 组内步数（「N 步」文案、下钻面包屑都用它） */
    steps: number;
    /** 字段值（键序 = `USAGE_FIELDS` 顺序；未适用粒度的列不出现） */
    fields: Readonly<Record<string, FieldValue>>;
}

/** 下钻过滤（`turn` 行 → 该轮 step；`persona` 行 → 该人物 turn） */
export interface UsageFilter {
    field: "turnId" | "persona";
    value: string;
}

// ─── 取值小工具（都只读 StepContext，不碰 IO）────────────────────────────

const bucketOf =
    (k: keyof UsageBuckets) =>
    (s: StepContext): number | null => {
        const v = s.view.buckets[k];
        return typeof v === "number" ? v : null;
    };

const costOf =
    (k: keyof CostBreakdown) =>
    (s: StepContext): number | null => {
        const c = s.view.cost;
        if (!c) return null;
        const v = c[k];
        return typeof v === "number" ? v : null;
    };

/** 单价快照文本（`入/出/读/写 · 档`；缺 → null） */
const rateText = (s: StepContext): string | null => {
    const r = s.record.rates;
    if (!r) return null;
    const opt = (v: number | null | undefined): string => (typeof v === "number" ? String(v) : "–");
    return `${r.input}/${r.output}/${opt(r.cacheRead)}/${opt(r.cacheWrite)} · ${r.tier}`;
};

/** 构成三段（字节 ÷ 4 估算；历史 = prompt − 系统 − 工具）。无 `contextParts` → 全 null */
const partsOf = (s: StepContext): { system: number; tools: number; history: number; prompt: number } | null => {
    const cp = s.record.contextParts;
    if (!cp) return null;
    const prompt = s.view.buckets.inputTotal;
    const system = Math.round(cp.systemBytes / 4);
    const tools = Math.round(cp.toolsBytes / 4);
    return { system, tools, history: Math.max(0, prompt - system - tools), prompt };
};

/** 投递压缩徽章文本（**仅轮首步有**；与事件无关：每轮按当前配置重建） */
const deliveryCompactText = (s: StepContext): string | null => {
    const h = s.record.historySelection;
    if (!h) return null;
    const tok = (n: number | undefined): string => (typeof n === "number" ? fmtTokens(n) : "?");
    if (!h.droppedMessages && !h.droppedTokens) return `无裁剪（上限 ${tok(h.limitTokens)}）`;
    return `留 ${tok(h.keptTokens)} / 丢 ${tok(h.droppedTokens)}（上限 ${tok(h.limitTokens)}）`;
};

/** 组内速度（Σ总输出 ÷ Σ响应耗时；含首字等待，口径 = `avgRate`） */
const bucketRate = (b: UsageBucket): number | null =>
    avgRate(b.views.map((v) => ({ performance: v.record.performance, outputTokens: v.buckets.outputTotal })));

// ─── 列定义（44 个 spec；顺序 = body §三 的 22 行，展开项紧随其行）────────

export const USAGE_FIELDS: readonly UsageFieldSpec[] = [
    // 1 轮
    {
        key: "turnId",
        label: "轮",
        gran: ["step", "turn"],
        agg: "none",
        fmt: "text",
        hint: "轮次 id（与 steps/turns 可 join）",
        width: 132,
        compute: (b) => b.first.record.turnId,
    },
    // 2 时间（step = 该步 ts；turn = 轮首 ts —— 修正旧 C 总表「从 turnId 解时间」）
    {
        key: "turnAt",
        label: "时间",
        gran: ["step", "turn"],
        agg: "none",
        fmt: "datetime",
        hint: "step = 该步记录时刻；turn = 本轮首步时刻",
        width: 150,
        compute: (b) => b.first.record.ts,
    },
    // 3 步
    {
        key: "stepNo",
        label: "步",
        gran: ["step"],
        agg: "none",
        fmt: "int",
        hint: "轮内第几步（1-based）",
        width: 56,
        pick: (s) => s.record.step,
    },
    // 4 人物（P 的分组键；step 为单值，高层给集合）
    {
        key: "persona",
        label: "人物",
        gran: ["step", "turn", "persona", "session"],
        agg: "set",
        fmt: "text",
        hint: "— = 未绑定；高层为集合（同一轮/会话可能换人物）",
        width: 96,
        pick: (s) => s.record.persona ?? "—",
    },
    // 5 模型
    {
        key: "model",
        label: "模型",
        gran: ["step", "turn", "persona", "session"],
        agg: "set",
        fmt: "text",
        hint: "请求模型（计价模型见「单价」）",
        width: 150,
        pick: (s) => s.record.model,
    },
    // 6 面
    {
        key: "apiFace",
        label: "面",
        gran: ["step", "turn", "persona", "session"],
        agg: "set",
        fmt: "text",
        hint: "chat / responses",
        width: 88,
        pick: (s) => s.record.apiFace,
    },
    // 7 档位
    {
        key: "reasoningEffort",
        label: "档位",
        gran: ["step", "turn", "persona", "session"],
        agg: "set",
        fmt: "text",
        hint: "推理档位（步级属性，不能当分组键）",
        width: 80,
        pick: (s) => s.record.reasoningEffort ?? "—",
    },
    // 8 步数
    {
        key: "stepCount",
        label: "步数",
        gran: ["turn", "persona", "session"],
        agg: "count",
        fmt: "int",
        hint: "组内步数（与 token 合计不同类：计数）",
        width: 64,
    },
    // 9 非缓存
    {
        key: "noCacheTokens",
        label: "非缓存",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "token",
        hint: "未命中前缀缓存、按全价计",
        width: 88,
        pick: bucketOf("noCache"),
    },
    // 10 缓存读
    {
        key: "cacheReadTokens",
        label: "缓存读",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "token",
        hint: "暖输入（按缓存读单价）",
        width: 88,
        pick: bucketOf("cacheRead"),
    },
    // 11 缓存写（全组不可测 → null，不是 0）
    {
        key: "cacheWriteTokens",
        label: "缓存写",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum-with-null",
        fmt: "token",
        hint: "该 API 面不可测 → –（不是 0）",
        width: 88,
        pick: bucketOf("cacheWrite"),
    },
    // 12 文本
    {
        key: "textTokens",
        label: "文本",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "token",
        hint: "总输出的子集（不另加价）",
        width: 88,
        pick: bucketOf("text"),
    },
    // 13 思考
    {
        key: "reasoningTokens",
        label: "思考",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "token",
        hint: "总输出的子集（不另加价）",
        width: 88,
        pick: bucketOf("reasoning"),
    },
    // 14 总输入
    {
        key: "inputTotalTokens",
        label: "总输入",
        gran: ["step", "turn", "persona", "session"],
        agg: "recompute",
        fmt: "token",
        hint: "= 非缓存 + 缓存读 + 缓存写",
        width: 92,
        compute: (b) => b.buckets.inputTotal,
    },
    // 15 总输出
    {
        key: "outputTotalTokens",
        label: "总输出",
        gran: ["step", "turn", "persona", "session"],
        agg: "recompute",
        fmt: "token",
        hint: "= 文本 + 思考",
        width: 92,
        compute: (b) => b.buckets.outputTotal,
    },
    // 16 合计（窗口分子口径，不是窗口占用）
    {
        key: "totalTokens",
        label: "合计",
        gran: ["step", "turn", "persona", "session"],
        agg: "recompute",
        fmt: "token",
        hint: "= 总输入 + 总输出（各步之和；**不是**窗口占用）",
        width: 92,
        compute: (b) => b.buckets.total,
    },
    // 17 缓存命中（聚合桶重算，禁止平均比率）
    {
        key: "cacheHitRate",
        label: "缓存命中",
        gran: ["step", "turn", "persona", "session"],
        agg: "recompute",
        fmt: "pct",
        hint: "= Σ缓存读 ÷ Σ总输入（不是各步比率的平均）",
        width: 92,
        compute: (b) => cacheHitRate(b.buckets),
    },
    // 18 窗口占用（最后一步；加和会变成假 1M）
    {
        key: "windowTotalTokens",
        label: "窗口占用",
        gran: ["step", "turn", "persona", "session"],
        agg: "last-step",
        fmt: "token",
        hint: "该组**最后一步**的总输入+总输出（上下文压力口径，不是加和）",
        width: 96,
        pick: (s) => s.view.buckets.total,
    },
    // 19 窗口%
    {
        key: "windowRate",
        label: "窗口%",
        gran: ["step", "turn", "persona", "session"],
        agg: "last-step",
        fmt: "pct",
        hint: "该步 总输入+总输出 ÷ 模型上下文上限（上限未知 → –）",
        width: 84,
        pick: (s) => s.view.windowRate,
    },
    // 20 上限
    {
        key: "contextLimit",
        label: "上限",
        gran: ["step", "turn", "persona", "session"],
        agg: "last-step",
        fmt: "token",
        hint: "该步所用模型的上下文上限",
        width: 88,
        pick: (s) => s.record.contextLimit ?? null,
    },
    // 21 耗时（含客户端工具执行，仅参考）
    {
        key: "stepTimeMs",
        label: "耗时",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "ms",
        hint: "含客户端工具执行（仅参考，不作速度分母）",
        width: 90,
        pick: (s) => s.record.performance?.stepTimeMs ?? null,
    },
    // 22 响应耗时（速度分母；此前无列）
    {
        key: "responseTimeMs",
        label: "响应耗时",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "ms",
        hint: "模型响应耗时（含首字等待）= 速度分母",
        width: 96,
        pick: (s) => s.record.performance?.responseTimeMs ?? null,
    },
    // 23 TTFT（不可聚合：只 step 有值）
    {
        key: "ttftMs",
        label: "TTFT",
        gran: ["step"],
        agg: "none",
        fmt: "ms",
        hint: "首字等待；聚合级无意义（高层空）",
        width: 88,
        pick: (s) => s.record.performance?.timeToFirstOutputMs ?? null,
    },
    // 24 速度（三档各一格；按定义现算，不是比率的聚合）
    {
        key: "rate",
        label: "速度",
        gran: ["step"],
        agg: "none",
        fmt: "rate",
        hint: "该步总输出 ÷ 响应耗时（含首字等待）",
        width: 92,
        pick: (s) => stepRate(s.record.performance, s.view.buckets.outputTotal),
    },
    {
        key: "turnRate",
        label: "速度⚡",
        gran: ["turn"],
        agg: "none",
        fmt: "rate",
        hint: "本轮 Σ总输出 ÷ Σ响应耗时（含首字等待）",
        width: 92,
        compute: bucketRate,
    },
    {
        key: "sessionRate",
        label: "速度⌀",
        gran: ["session"],
        agg: "none",
        fmt: "rate",
        hint: "会话 Σ总输出 ÷ Σ响应耗时（含首字等待）",
        width: 92,
        compute: bucketRate,
    },
    // 25 金额（六项；快照值不按现价重算）
    {
        key: "cost.noCache",
        label: "非缓存$",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "money",
        hint: "按该步当时的生效单价（历史账不漂）",
        width: 90,
        pick: costOf("noCache"),
    },
    {
        key: "cost.cacheRead",
        label: "缓存读$",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "money",
        hint: "按该步当时的生效单价",
        width: 90,
        pick: costOf("cacheRead"),
    },
    {
        key: "cost.cacheWrite",
        label: "缓存写$",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum-with-null",
        fmt: "money",
        hint: "不可测 → –（不是 $0）",
        width: 90,
        pick: costOf("cacheWrite"),
    },
    {
        key: "cost.text",
        label: "文本$",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "money",
        hint: "输出单价 × 文本 token",
        width: 90,
        pick: costOf("text"),
    },
    {
        key: "cost.reasoning",
        label: "思考$",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "money",
        hint: "已含在输出单价里（拆解展示，不另加）",
        width: 90,
        pick: costOf("reasoning"),
    },
    {
        key: "cost.total",
        label: "合计$",
        gran: ["step", "turn", "persona", "session"],
        agg: "sum",
        fmt: "money",
        hint: "= 非缓存$ + 缓存读$ + 缓存写$ + 文本$ + 思考$",
        width: 96,
        pick: costOf("total"),
    },
    // 26 无价目步数（>0 ⇒ 合计是部分和）
    {
        key: "unpricedSteps",
        label: "无价目步",
        gran: ["turn", "persona", "session"],
        agg: "count",
        fmt: "int",
        hint: ">0 ⇒ 金额列是**部分和**（该步无价目，不是 $0）",
        width: 90,
        test: (s) => s.view.cost == null,
    },
    // 27 单价
    {
        key: "rates",
        label: "单价",
        gran: ["step", "turn", "persona", "session"],
        agg: "set",
        fmt: "text",
        hint: "入/出/读/写 · 档（$ / 1M tokens；同一组可能多档）",
        width: 220,
        pick: rateText,
    },
    // 28 窗口构成（仅 step：构成只对「一次请求」有意义，高层不求和）
    {
        key: "contextParts.system",
        label: "系统提示词",
        gran: ["step"],
        agg: "none",
        fmt: "token",
        hint: "~ 字节÷4 估算（不是 token 真值）",
        width: 96,
        pick: (s) => partsOf(s)?.system ?? null,
    },
    {
        key: "contextParts.tools",
        label: "工具定义",
        gran: ["step"],
        agg: "none",
        fmt: "token",
        hint: "~ 字节÷4 估算",
        width: 96,
        pick: (s) => partsOf(s)?.tools ?? null,
    },
    {
        key: "contextParts.history",
        label: "历史消息",
        gran: ["step"],
        agg: "none",
        fmt: "token",
        hint: "~ 该步总输入 − 系统 ~ − 工具 ~（导出值）",
        width: 96,
        pick: (s) => partsOf(s)?.history ?? null,
    },
    {
        key: "contextParts.systemShare",
        label: "系统%",
        gran: ["step"],
        agg: "recompute",
        fmt: "pct",
        hint: "系统 ÷ 同行总输入",
        width: 80,
        compute: (b) => {
            const p = partsOf(b.ctxs[0]!);
            return p && p.prompt > 0 ? p.system / p.prompt : null;
        },
    },
    {
        key: "contextParts.toolsShare",
        label: "工具%",
        gran: ["step"],
        agg: "recompute",
        fmt: "pct",
        hint: "工具 ÷ 同行总输入",
        width: 80,
        compute: (b) => {
            const p = partsOf(b.ctxs[0]!);
            return p && p.prompt > 0 ? p.tools / p.prompt : null;
        },
    },
    {
        key: "contextParts.historyShare",
        label: "消息%",
        gran: ["step"],
        agg: "recompute",
        fmt: "pct",
        hint: "历史消息 ÷ 同行总输入",
        width: 80,
        compute: (b) => {
            const p = partsOf(b.ctxs[0]!);
            return p && p.prompt > 0 ? p.history / p.prompt : null;
        },
    },
    // 29 投递裁剪（账内真值：usage.historySelection，仅轮首步）
    {
        key: "deliveryCompact",
        label: "投递裁剪",
        gran: ["step"],
        agg: "none",
        fmt: "text",
        hint: "每轮按当前配置重建（没有压缩事件也算重算过）",
        width: 170,
        pick: deliveryCompactText,
    },
    // 30 压缩事件（**事件账在 compact.jsonl**；本层不造假数，值由刀 3 注入）
    {
        key: "compactEvents",
        label: "压缩事件",
        gran: ["step"],
        agg: "none",
        fmt: "text",
        hint: "事件来自 compact.jsonl（未注入 → –，不编 0）",
        width: 96,
        compute: () => null,
    },
    // 31 压缩边界（来自 turns.jsonl 的 compaction entry；仅事件行用，不属于四级粒度的列）
    {
        key: "compactRetainTokens",
        label: "保留量",
        gran: [],
        agg: "none",
        fmt: "token",
        hint: "turns.jsonl 压缩边界 v3：retainTokens（= 窗口 × 0.16）",
        width: 96,
    },
    {
        key: "compactWindowTokens",
        label: "窗口",
        gran: [],
        agg: "none",
        fmt: "token",
        hint: "turns.jsonl 压缩边界 v3：windowTokens",
        width: 96,
    },
];

// ─── 聚合（唯一实现）──────────────────────────────────────────────────────

/** 逐步取值 → 数值列表（`null` 不算数） */
function numbers(spec: UsageFieldSpec, b: UsageBucket): number[] {
    const out: number[] = [];
    for (const ctx of b.ctxs) {
        const v = spec.pick?.(ctx);
        if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    }
    return out;
}

function valueOf(spec: UsageFieldSpec, b: UsageBucket, gran: Gran): FieldValue {
    switch (spec.agg) {
        case "count": {
            if (!spec.test) return b.steps.length;
            let n = 0;
            for (const ctx of b.ctxs) if (spec.test(ctx)) n++;
            return n;
        }
        case "sum":
        case "sum-with-null": {
            // 两者**共用一句实现**（本组一个实测值都没有 → null，绝不写 0）：
            //   · `sum` 的语义是「该字段本来可以缺」，缺了就不进和；
            //   · `sum-with-null` 是「全组都不可测 → –」的显式声明（缓存写/缓存写$）。
            // 现有数据下两者结果一致（`null` 与「没有这个值」在账本里是同一件事），
            // 分两种 kind 是为了让列声明能一眼看出「这列有不可测状态」——单测按 kind 断言。
            const nums = numbers(spec, b);
            return nums.length === 0 ? null : nums.reduce((a, x) => a + x, 0);
        }
        case "last-step":
            return spec.pick?.(b.ctxs[b.ctxs.length - 1]!) ?? null;
        case "set": {
            const seen = new Set<string>();
            for (const ctx of b.ctxs) {
                const v = spec.pick?.(ctx);
                if (typeof v === "string" && v.length > 0) seen.add(v);
            }
            const list = [...seen];
            if (list.length === 0) return null;
            // 单值退化：step 粒度（以及大部分组）就一个身份，UI 不该拿到长度 1 的数组
            return list.length === 1 ? list[0]! : list;
        }
        case "recompute":
            return spec.compute ? spec.compute(b, gran) : null;
        case "none":
        default:
            if (spec.compute) return spec.compute(b, gran);
            return gran === "step" ? (spec.pick?.(b.ctxs[0]!) ?? null) : null;
    }
}

/** 组键（step 用 `turnId#step` 保证唯一；其余直接用分组维度值） */
function keyOf(s: StepContext, gran: Gran): string {
    switch (gran) {
        case "step":
            return `${s.record.turnId}#${s.record.step}`;
        case "turn":
            return s.record.turnId;
        case "persona":
            return s.record.persona ?? "—";
        case "session":
            return "session";
    }
}

/** 行序：step 按 (turnId, step)；turn 按时间升序；persona/session 按合计$ 降序（无金额垫底） */
function compareRows(a: UsageRow, b: UsageRow): number {
    if (a.gran === "step") {
        const [at, as] = a.key.split("#");
        const [bt, bs] = b.key.split("#");
        return at === bt ? Number(as) - Number(bs) : at! < bt! ? -1 : 1;
    }
    if (a.gran === "turn") return String(a.fields["turnAt"] ?? "") < String(b.fields["turnAt"] ?? "") ? -1 : 1;
    const ac = typeof a.fields["cost.total"] === "number" ? (a.fields["cost.total"] as number) : -1;
    const bc = typeof b.fields["cost.total"] === "number" ? (b.fields["cost.total"] as number) : -1;
    if (ac !== bc) return bc - ac;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * 单步组（`gran === "step"` 的快路径）：一条记录就是一个桶，
 * 直接复用该步已算好的桶/金额 —— 不再 `sumBuckets([x])` / 过滤 priced / 排序，
 * 6.8k 步的逐步视图因此少掉 n 次小数组分配（实测占其主要开销）。
 */
function makeSingleBucket(ctx: StepContext, key: string): UsageBucket {
    return {
        key,
        steps: [ctx.record],
        views: [ctx.view],
        ctxs: [ctx],
        buckets: ctx.view.buckets,
        cost: ctx.view.cost,
        unpriced: ctx.view.cost == null ? 1 : 0,
        first: ctx.view,
        last: ctx.view,
    };
}

function makeBucket(key: string, views: StepView[]): UsageBucket {
    const sorted = [...views].sort((x, y) => x.record.step - y.record.step);
    const priced = sorted.filter((v) => v.cost != null).map((v) => v.cost!);
    return {
        key,
        steps: sorted.map((v) => v.record),
        views: sorted,
        ctxs: sorted.map((view) => ({ record: view.record, view })),
        buckets: sumBuckets(sorted.map((v) => v.buckets)),
        cost: priced.length ? sumCosts(priced) : null,
        unpriced: sorted.length - priced.length,
        first: sorted[0]!,
        last: sorted[sorted.length - 1]!,
    };
}

/**
 * 四级粒度聚合 —— **唯一实现**（renderer 只格式化，CLI 也只调它）。
 *
 * · `filter` 在**分桶之前**生效：下钻 = 同一函数换参数（`turn` 行 → `step` + `turnId`），
 *   不是第二条代码路径。
 * · 返回行的 `fields` 只含**适用该粒度**的列（`USAGE_FIELDS` 按 `gran` 过滤）；
 *   键序 = `USAGE_FIELDS` 顺序 → 表头顺序天然稳定。
 * · 空输入 → `[]`（不返回一行全 `–` 的假合计）。
 */
export function aggregateUsage(
    rows: readonly StepUsageRecord[],
    gran: Gran,
    filter?: UsageFilter,
): UsageRow[] {
    const picked = filter ? rows.filter((r) => (r[filter.field] ?? "—") === filter.value) : rows;
    const map = new Map<string, StepView[]>();
    for (const r of picked) {
        const view = stepView(r);
        const k = keyOf({ record: r, view }, gran);
        const arr = map.get(k) ?? [];
        arr.push(view);
        map.set(k, arr);
    }
    const out: UsageRow[] = [];
    for (const [key, views] of map) {
        const bucket =
            gran === "step"
                ? makeSingleBucket({ record: views[0]!.record, view: views[0]! }, key)
                : makeBucket(key, views);
        const fields: Record<string, FieldValue> = {};
        for (const spec of USAGE_FIELDS) {
            if (!spec.gran.includes(gran)) continue;
            fields[spec.key] = valueOf(spec, bucket, gran);
        }
        out.push({ gran, key, steps: bucket.steps.length, fields });
    }
    return out.sort(compareRows);
}

// ─── 格式化（UI/CLI 共用字形；`null` 一律 `–`，**不写 0**）──────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 时间到秒（本地时区）：`YYYY-MM-DD HH:mm:ss`；非法 → `–` */
function fmtDateTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "–";
    return (
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    );
}

/** 耗时：≥1s 用两位小数秒，否则整毫秒（与 CLI `cellMs` 同字形） */
function fmtMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * 单元格字形 —— **唯一入口**（各表不许再各写一套 `fmtCost`/`toFixed`）。
 *
 * · `null` / `undefined` / `NaN` → `–`（不可测，不是 0）
 * · 数组（`set` 多值）→ `a / b / c`（UI 若要「+N」摘要，在渲染层收窄，不改这里）
 */
export function fmtCell(v: FieldValue | undefined, fmt: FieldFmt): string {
    if (v == null) return "–";
    if (Array.isArray(v)) return v.length === 0 ? "–" : v.join(" / ");
    if (typeof v === "string") {
        if (fmt === "datetime") return fmtDateTime(v);
        return v.length === 0 ? "–" : v;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) return "–";
    switch (fmt) {
        case "int":
            return fmtInt(Math.round(v));
        case "token":
            return fmtTokens(v);
        case "money":
            return `$${fmtCost(v)}`;
        case "pct":
            return `${(v * 100).toFixed(1)}%`;
        case "ms":
            return fmtMs(v);
        case "rate":
            return fmtRate(v);
        case "datetime":
        case "text":
        default:
            return String(v);
    }
}

/** 该粒度下要显示的列（表 = 过滤；渲染层直接 `<For each={columnsFor(gran)}>`） */
export function columnsFor(gran: Gran): readonly UsageFieldSpec[] {
    return USAGE_FIELDS.filter((c) => c.gran.includes(gran));
}

/** 合计是否**不完整**（无价目步 > 0）—— 渲染层据此标「部分和」 */
export function isPartial(row: UsageRow): boolean {
    const n = row.fields["unpricedSteps"];
    return typeof n === "number" && n > 0;
}
