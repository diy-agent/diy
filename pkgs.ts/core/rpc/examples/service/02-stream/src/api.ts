/**
 * 02-stream —— 服务端流（**推荐写法**）
 *
 * 跑：`npx tsx pkgs.ts/core/rpc/examples/service/02-stream/run.ts`
 */
import { z } from "zod";
import { RpcSchema } from "../../../../src/index";

export const jobRoutes = RpcSchema.group({ children: {
    job: RpcSchema.group({ children: {
        /** 逐行吐进度；`output` 是**每一块**的类型，不是最终结果 */
        progress: RpcSchema.serverStream({
            input: { total: z.number() },
            output: z.object({ done: z.number(), text: z.string() }),
        }),
    } }),
} });

