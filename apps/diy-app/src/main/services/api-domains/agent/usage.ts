/**
 * api-domains/agent/usage.ts —— 从 api-def.ts 的 `agent.usage` 拆出（单个 unary）。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";

export const usageRoute = RpcSchema.unary({
  desc: `查看任务会话的 token 用量与金额（逐步明细 / --by-agent 按人物+模型+面+档位汇总）`,
  input: {
    task: z.string().cliArg({ desc: "任务 URI" }),
    last: z.number().optional().cliOption({ desc: "只看最近 N 步" }),
    cost: z.boolean().optional().cliOption({ desc: "展开金额细分列（非缓存/缓存读/缓存写/文本/思考）" }),
    byAgent: z.boolean().optional().cliOption({ desc: "按人物+模型+面+档位汇总（多 agent 多行）" }),
  },
  output: z.string(),
})
