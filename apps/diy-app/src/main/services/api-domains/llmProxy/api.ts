/**
 * api-domains/llmProxy/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
/** 与 api-def.ts 的同名局部常量同形（那边没导出） */
const StatusOk = z.object({ status: z.string() });

export const llmProxyRoutes = RpcSchema.group({desc: `LLM 代理`,
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
        },});

export const llmProxyService = defineService({ name: "diy.llmProxy", api: llmProxyRoutes });
