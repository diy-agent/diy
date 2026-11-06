/**
 * demo/src/api.ts — 示例用的 api 定义
 *
 * 放在 `<dir>/src/api.ts` 是因为 `gen-service-types` 的扫描约定就是这个形状 ——
 * 和真实包（`pkgs.ts/ui/workbench/src/api.ts`）完全一样，示例即示范。
 *
 * 生成：`npx tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts`
 * 产物：`examples/demo/src/gen/api.generated.d.ts`
 */
import { z } from "zod";
import { RpcSchema, defineService } from "../../../src/index";

export const taskRoutes = RpcSchema.router({
    task: RpcSchema.router({
        /** 列任务（可按状态过滤） */
        list: RpcSchema.unary({
            input: { status: z.enum(["pending", "done"]).optional(), limit: z.number().int().positive().optional() },
            output: z.array(z.object({ uri: z.string(), title: z.string(), done: z.boolean() })),
            desc: "列任务",
        }),
        /** 按 uri 取一个任务 */
        get: RpcSchema.unary({
            input: { uri: z.string() },
            output: z.object({ uri: z.string(), title: z.string(), done: z.boolean() }),
        }),
    }),
});

export const taskService = defineService({ name: "demo.task", api: taskRoutes });
