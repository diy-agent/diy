// src/shared/context/schema.ts
// 🎯 Context 预览的 RPC 契约（zod；类型从 preview.ts 推导，两边不会漂移）。

import { z } from "zod";
import type { ContextPreview } from "./preview";

/** 试验场「系统上下文」view 的输出：树 + 每步投递动作（只组装，不发 LLM） */
export const ContextPreviewSchema: z.ZodType<ContextPreview> = z.object({
    scenario: z.string(),
    title: z.string(),
    wireVersion: z.string(),
    places: z.array(
        z.object({ path: z.string(), container: z.enum(["system", "runtime"]) }),
    ),
    nodes: z.array(
        z.object({
            path: z.string(),
            renderer: z.string(),
            preview: z.string(),
            valueHash: z.string(),
        }),
    ),
    system: z.string(),
    runtimeText: z.string(),
    steps: z.array(
        z.object({
            note: z.string(),
            delivery: z.string(),
            needRebaseline: z.boolean(),
            changed: z.array(z.string()),
        }),
    ),
});
