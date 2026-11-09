/**
 * api-domains/project/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { StatusDataId } from "../../../../shared/status";
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
          /**
           * 弹出原生目录选择器（renderer「选择目录」按钮反向调用）。
           *
           * 2026-11 从 api-def 顶层 `pickProjectDirectory` 归到 project 域 —— 选的是**项目目录**。
           * Web/serve 模式没有 Electron dialog，返回 `canceled: true`。
           */
          pick: RpcSchema.unary({
            desc: `弹出原生目录选择器，返回所选路径`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                canceled: z.boolean(),
                path: z.string().optional(),
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
