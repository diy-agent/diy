// src/shared/context/schema.ts
// 🎯 上下文树页的 RPC 契约（zod；类型从 preview.ts 推导，两边不会漂移）。

import { z } from "zod";
import type { ContextLab, PlaceCandidate } from "./preview";
import type { StepSummary } from "./steps";

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
});
export type ContextDiff = z.infer<typeof ContextDiffSchema>;
