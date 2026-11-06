/**
 * api-domains/log/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const logRoutes = RpcSchema.group({desc: `日志`,
        children: {
          read: RpcSchema.unary({
            desc: `读取日志`,
            input: {
              limit: z.number().optional().cliOption({ desc: "返回条目数" }),
            },
            output: z.array(z.object({
              timestamp: z.string().optional(),
              level: z.string().optional(),
              message: z.string().optional(),
              raw: z.string().optional(),
            })),
          }),
        },});

export const logService = defineService({ name: "diy.log", api: logRoutes });
