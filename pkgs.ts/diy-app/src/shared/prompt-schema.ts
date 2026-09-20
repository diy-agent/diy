// src/shared/prompt-schema.ts
// 🎯 提示词模版域的**唯一契约源**（纯 zod，无 node 依赖）。
//
// 为什么单独一个文件：
//   - api-def.ts（main + renderer 双向共用）在这里取 output schema；
//   - prompt-registry.ts（main 实现）从这里取 TS 类型；
//   - renderer 的 promptLabCommon 也从这里取类型。
//   三处共用一份定义，才不会有「手抄第二份 PromptEntry」的漂移（历史问题）。
//
// 约定：本文件只放 schema/类型，禁止 import node:fs 等 main 专属模块 —— renderer 会打进包。

import { z } from "zod";

/** 模版条目（含生效正文与覆盖状态） */
export const PromptEntrySchema = z.object({
  relpath: z.string(),
  title: z.string(),
  desc: z.string(),
  version: z.number(),
  /** 是否锁定（不可覆盖）；命名约定：`_` 前缀 = 锁定，由 lint 保证一致 */
  locked: z.boolean(),
  /** 锁定时展示给用户的理由 */
  lockTip: z.string(),
  /** 角色：入口 / 节（被入口 include）/ 片段（只被引用）——由 `_system.md` 的 include 推导 */
  role: z.enum(["entry", "section", "fragment"]),
  status: z.enum(["builtin", "overridden"]),
  current: z.string(),
  builtin: z.string(),
  baseVersion: z.number().nullable(),
  stale: z.boolean(),
});
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

/** 变量契约条目（宿主注入的变量：路径 + 粗细类型 + 说明） */
export const VarSpecSchema = z.object({
  path: z.string(),
  type: z.enum(["string", "number", "boolean", "array", "object"]),
  desc: z.string().optional(),
});
export type VarSpec = z.infer<typeof VarSpecSchema>;

/** 渲染结构 trace 节点（试验场「结构树」：每个节点的产出字节 + :if 真假原因 + 迭代次数） */
export type TraceNode = {
  kind: string;
  name?: string;
  bytes: number;
  result?: boolean;
  reason?: string;
  children?: TraceNode[];
};
export const TraceNodeSchema: z.ZodType<TraceNode> = z.lazy(() =>
  z.object({
    kind: z.string(),
    name: z.string().optional(),
    bytes: z.number(),
    result: z.boolean().optional(),
    reason: z.string().optional(),
    children: z.array(TraceNodeSchema).optional(),
  }),
);

/** 系统上下文装配结果（真发与预览共用） */
export const AssembledSystemSchema = z.object({
  system: z.string(),
  overBudget: z.object({ used: z.number(), budget: z.number() }).nullable(),
  /** 环境级告警（如未注入 DIY_CLI）：提示词会失真，但不算用户操作错误 */
  warnings: z.array(z.string()),
  /** 结构 trace：仅预览请求时提供（真发不传，省一次分配） */
  trace: z.array(TraceNodeSchema).nullable(),
  /** 变量契约：宿主注入的变量清单（模版作者可用的"输入面"） */
  vars: z.array(VarSpecSchema),
});
export type AssembledSystem = z.infer<typeof AssembledSystemSchema>;

/** 试验场预览响应 = 装配结果 + 仿真请求体 */
export const RequestPreviewSchema = AssembledSystemSchema.extend({
  requestBody: z.record(z.string(), z.unknown()).nullable(),
  requestNote: z.string(),
});
export type RequestPreview = z.infer<typeof RequestPreviewSchema>;
