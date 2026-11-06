/**
 * api-domains/template/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { PromptEntrySchema, RequestPreviewSchema } from "@diy-agent/context/schema/prompt-schema";

export const templateRoutes = RpcSchema.group({desc: `提示词模版（内置只读，项目级覆盖；仅构造请求，不发 LLM）`,
        children: {
          list: RpcSchema.unary({
            desc: `列出全部模版（含状态/元数据，供树展示）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
            },
            output: z.array(PromptEntrySchema),
          }),
          get: RpcSchema.unary({
            desc: `取单份模版（含内置/当前/stale）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
            },
            output: PromptEntrySchema,
          }),
          save: RpcSchema.unary({
            desc: `保存项目级覆盖（不可覆盖项拒绝）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
              content: z.string().cliArg({ desc: "覆盖正文" }),
            },
            output: PromptEntrySchema,
          }),
          restore: RpcSchema.unary({
            desc: `一键恢复（删覆盖，回退内置）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
            },
            output: PromptEntrySchema,
          }),
          preview: RpcSchema.unary({
            desc: `dry-run 预览：装配系统上下文 + 仿真请求体（只组装不发送）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "任务 URI（任务场景与工作目录从它推，并以其 project 为准）" }),
              model: z.string().optional().cliOption({ desc: `模型 id（缺省 gpt-5.6-luna；应传会话实际选中的模型才算保真）` }),
              // 无 CLI 注解：CLI 解析器忽略，RPC 照传（未存盘草稿渲染用）
              drafts: z.record(z.string(), z.string()).optional().describe("未存盘草稿 relpath→正文"),
            },
            output: RequestPreviewSchema,
          }),
        },});

export const templateService = defineService({ name: "diy.template", api: templateRoutes });
