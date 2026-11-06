/**
 * 01-basic —— 最小可用：定义 → bind → use（**推荐写法**）
 *
 * 跑：`npx tsx pkgs.ts/core/rpc/examples/service/01-basic/run.ts`
 */
import { z } from "zod";
import { RpcSchema, defineService } from "../../../../src/index";

export const mathRoutes = RpcSchema.bindNames(RpcSchema.group({ children: {
    math: RpcSchema.group({ children: {
        add: RpcSchema.unary({
            input: { a: z.number(), b: z.number() },
            output: z.number(),
            desc: "a + b",
        }),
        /** 空 input 也要声明成 `{}`（调用时传 `{}`） */
        version: RpcSchema.unary({ input: {}, output: z.string() }),
    } }),
} }));

export const mathService = defineService({ name: "demo.math", api: mathRoutes });
