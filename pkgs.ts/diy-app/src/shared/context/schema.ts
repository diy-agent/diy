// src/shared/context/schema.ts
// 🎯 上下文树页的 RPC 契约（zod；类型从 preview.ts 推导，两边不会漂移）。

import { z } from "zod";
import type { ContextLab, PlaceCandidate } from "./preview";

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
