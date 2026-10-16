// src/shared/context/schema.ts
// 🎯 上下文树页的 RPC 契约（zod；类型从 preview.ts 推导，两边不会漂移）。

import { z } from "zod";
import type { ContextLab, PlaceCandidate } from "./preview";
import type { StepSummary } from "./steps";
import type { CtxChangeRow, CtxLogRef } from "./changelog";

const Container = z.enum(["system", "runtime"]);

/** 一份投递：文本 + 每个 path 的行号区间（选中联动高亮用） */
const delivery = z.object({
    places: z.array(z.string()),
    text: z.string(),
    bytes: z.number(),
    lines: z.record(z.string(), z.object({ from: z.number(), to: z.number() })),
});

/** 候选投递单元（规则表里可选的行） */
export const ContextPlaceCandidateSchema: z.ZodType<PlaceCandidate[]> = z.array(
    z.object({
        path: z.string(),
        system: z.boolean(),
        reason: z.string(),
    }),
);

/** 上下文树数据：**当前任务的真实上下文**（只组装，不发 LLM） */
export const ContextLabSchema: z.ZodType<ContextLab> = z.object({
    taskUri: z.string(),
    source: z.string(),
    wireVersion: z.string(),
    tree: z.array(
        z.object({
            path: z.string(),
            isPlace: z.boolean(),
            renderer: z.string(),
            preview: z.string(),
            valueHash: z.string(),
            place: z.string().nullable(),
            container: Container.nullable(),
            hasValue: z.boolean(),
        }),
    ),
    rules: z.array(
        z.object({
            place: z.string(),
            container: Container,
            renders: z.array(z.string()),
            reason: z.string(),
        }),
    ),
    system: delivery,
    runtime: delivery,
    request: z.object({
        body: z.record(z.string(), z.unknown()).nullable(),
        note: z.string(),
        model: z.string(),
    }),
});

/** 行级 diff 的一行（`@diy/line-diff` 的形状） */
const diffLine = z.object({ t: z.string(), s: z.string() });

/** 一步的摘要（见 shared/context/steps.ts 的 summarizeSteps） */
export const StepSummarySchema: z.ZodType<StepSummary> = z.object({
    index: z.number(),
    ts: z.string(),
    turnId: z.string(),
    model: z.string(),
    wireVersion: z.string(),
    bytes: z.object({ system: z.number(), runtime: z.number() }),
    systemPlaces: z.array(z.string()),
    runtimePlaces: z.array(z.string()),
    sincePrev: z
        .object({
            changed: z.array(z.string()),
            systemDiffers: z.boolean(),
            runtimeDiffers: z.boolean(),
            incomparable: z.boolean(),
            systemSize: z.object({ add: z.number(), del: z.number() }),
            runtimeSize: z.object({ add: z.number(), del: z.number() }),
        })
        .nullable(),
    diff: z.object({ system: z.array(diffLine), runtime: z.array(diffLine) }).nullable().optional(),
});

/** 真发投递快照列表（每轮一条；见 main 的 readDeliverySteps） */
export const StepsSchema = z.object({
    /** 磁盘上总条数（可能大于返回的 steps.length —— limit 截尾） */
    total: z.number(),
    steps: z.array(StepSummarySchema),
});

/** 行级 diff 结果（见 main 的 app.context.diff：main 侧算完，renderer 只画） */
export const ContextDiffSchema = z.object({
    /** step = 某步 vs 上一步；live = **当前变量树** vs 最后一步 */
    mode: z.enum(["step", "live"]),
    base: z.object({ index: z.number(), ts: z.string(), turnId: z.string() }).nullable(),
    target: z.object({ index: z.number(), ts: z.string(), turnId: z.string(), model: z.string() }).nullable(),
    /** wire 版本不同 → 不可比（不是"内容变了"） */
    incomparable: z.boolean(),
    changed: z.array(z.string()),
    systemDiffers: z.boolean(),
    runtimeDiffers: z.boolean(),
    systemDiff: z.array(diffLine),
    runtimeDiff: z.array(diffLine),
    /** target 侧的**全文**（system 信封 / runtime 信封）—— `<>` 原始数据视图用。
     *  为什么随 diff 一起给：那两个 view 的"原始数据"就是这份文本本身，另开一个 RPC
     *  只会多一次 round-trip 且两份可能不同源（diff 是同一份 steps 记录算的）。 */
    systemText: z.string(),
    runtimeText: z.string(),
    /** base 侧全文（没有上一步 = null）—— 供"两侧对照"看原始数据 */
    baseSystemText: z.string().nullable(),
    baseRuntimeText: z.string().nullable(),
});
export type ContextDiff = z.infer<typeof ContextDiffSchema>;

/** 节点变更统计（见 shared/context/stats.ts 的 summarizeStats） */
export const StatsSchema = z.object({
    turns: z.number(),
    records: z.number(),
    taskCount: z.number(),
    since: z.string().nullable(),
    until: z.string().nullable(),
    paths: z.array(
        z.object({
            path: z.string(),
            changes: z.number(),
            rate: z.number(),
            lastChanged: z.string().nullable(),
            turns: z.array(z.number()),
        }),
    ),
});
export type Stats = z.infer<typeof StatsSchema>;

/**
 * 变更历史的一条**记录视图**（##310 二版）：每步一条（有变才写；首条 = baseline）。
 * 附带的徽章两段来源不同、都可能不可得（→ null，UI 不画徽章，不谎报）：
 *   · 划分与两份容器是否变 ← 真发投递快照（按 turnId join；快照已被清理就没有）
 *   · 缓存率与金额 ← 用量账本（`local/<key>.usage.jsonl`，按 turnId join）
 */
export interface HistoryEntryView {
    seq: number;
    type: "baseline" | "changed";
    ts: string;
    model: string;
    wireVersion: string;
    ref: CtxLogRef;
    /** 该条所属轮在**投递快照**里的 1 基序号（点行驱动中栏 diff 用；快照不可得 = null） */
    turnIndex: number | null;
    changes: CtxChangeRow[];
    systemPlaces: string[];
    systemDiffers: boolean | null;
    runtimeDiffers: boolean | null;
    incomparable: boolean | null;
    cacheHitRate: number | null;
    cost: number | null;
}

/** 变更历史的一行变更（见 shared/context/changelog.ts 的 CtxChangeRow） */
const changeRowSchema: z.ZodType<CtxChangeRow> = z.object({
    kind: z.enum(["add", "update", "remove"]),
    path: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
});

/** 变更历史的一条记录 */
const historyEntrySchema: z.ZodType<HistoryEntryView> = z.object({
    seq: z.number(),
    type: z.enum(["baseline", "changed"]),
    ts: z.string(),
    model: z.string(),
    wireVersion: z.string(),
    ref: z.object({ turnId: z.string(), stepId: z.string(), step: z.number() }),
    turnIndex: z.number().nullable(),
    changes: z.array(changeRowSchema),
    systemPlaces: z.array(z.string()),
    systemDiffers: z.boolean().nullable(),
    runtimeDiffers: z.boolean().nullable(),
    incomparable: z.boolean().nullable(),
    cacheHitRate: z.number().nullable(),
    cost: z.number().nullable(),
});

/** 变更历史（见 app.context.changelog） */
export const CtxLogSchema = z.object({
    /** 总条数（可能大于 entries.length —— limit 截尾） */
    total: z.number(),
    /** log = 变更日志本体；derived = 该任务还没有日志，从投递快照的值 hash 折算（无值预览） */
    source: z.enum(["log", "derived"]),
    entries: z.array(historyEntrySchema),
});
export type CtxLog = z.infer<typeof CtxLogSchema>;
