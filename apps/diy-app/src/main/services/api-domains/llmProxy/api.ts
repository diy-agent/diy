/**
 * api-domains/llmProxy/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { StatusOk } from "../../../../shared/status";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const llmProxyRoutes = RpcSchema.group({
    desc: `LLM 代理`,
    children: {
        status: RpcSchema.unary({
            desc: `查询 LLM 代理状态`,
            input: {},
            output: z.object({ running: z.boolean(), port: z.number() }),
        }),
        start: RpcSchema.unary({
            desc: `启动 LLM 代理`,
            input: {},
            output: StatusOk,
        }),
        stop: RpcSchema.unary({
            desc: `停止 LLM 代理`,
            input: {},
            output: StatusOk,
        }),
    },
});

export const llmProxyService = defineService({ name: "diy.llmProxy", api: llmProxyRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: llmProxyApi, handlers: { llmProxy: … } })`
 * 与上面的 `llmProxyService` 完全等价（后者 = prefix "diy" + 模块层 "llmProxy"）。
 */
export const llmProxyApi = RpcSchema.group({ children: { llmProxy: llmProxyRoutes } });
