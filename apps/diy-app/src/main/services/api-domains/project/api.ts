/**
 * api-domains/project/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
/** 与 api-def.ts 的同名局部常量同形（那边没导出） */
const StatusDataId = z.object({ status: z.string(), data: z.object({ id: z.string() }) });

export const projectRoutes = RpcSchema.group({desc: `项目管理`,
        children: {
          create: RpcSchema.unary({
            desc: `创建项目（path 必填，id 自动生成并返回 {id}）`,
            input: {
              path: z.string().min(1, "path 不能为空").cliArg({ desc: "项目路径（映射到该目录下的 diy.yaml）" }),
              label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
              desc: z.string().optional().cliOption({ desc: "描述" }),
              state: z.string().optional().cliOption({ desc: "状态" }),
            },
            output: StatusDataId,
          }),
          list: RpcSchema.unary({
            desc: `列出项目`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                projects: z.array(
                  z.object({
                    id: z.string(),
                    info: z.object({
                      label: z.string().optional(),
                      path: z.string().optional(),
                      desc: z.string().optional(),
                      state: z.string().optional(),
                    }),
                  }),
                ),
              }),
            }),
          }),
          remove: RpcSchema.unary({
            desc: `删除项目`,
            input: {
              id: z.string().cliArg({ desc: "project id" }),
            },
            output: StatusDataId,
          }),
        },});

export const projectService = defineService({ name: "diy.project", api: projectRoutes });
