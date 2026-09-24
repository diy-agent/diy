// src/shared/context/schema.ts
// 🎯 上下文树试验场的 RPC 契约（zod；类型从 preview.ts 推导，两边不会漂移）。

import { z } from "zod";
import type { ContextLab } from "./preview";

const Container = z.enum(["system", "runtime"]);

/** 试验场输出：树 + 划分规则 + 两份投递 + 合成消息（只组装，不发 LLM） */
export const ContextLabSchema: z.ZodType<ContextLab> = z.object({
    scenario: z.string(),
    title: z.string(),
    note: z.string(),
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
    system: z.object({ places: z.array(z.string()), text: z.string(), bytes: z.number() }),
    runtime: z.object({ places: z.array(z.string()), text: z.string(), bytes: z.number() }),
    message: z.object({ system: z.string(), user: z.string(), note: z.string() }),
});
