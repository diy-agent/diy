/**
 * 03-cancel —— 取消传到服务端（**推荐写法**）
 *
 * 跑：`npx tsx pkgs.ts/core/rpc/examples/service/03-cancel/run.ts`
 */
import { z } from "zod";
import { RpcSchema, defineService } from "../../../../src/index";

export const slowRoutes = RpcSchema.router({
    slow: RpcSchema.unary({ input: { ms: z.number() }, output: z.string() }),
});

export const slowService = defineService({ name: "demo.slow", api: slowRoutes });
