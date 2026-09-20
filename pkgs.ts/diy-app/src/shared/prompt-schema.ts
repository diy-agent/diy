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
  /** 包裹标签名（空串 = 裸文本节，不包 <...>）：来自模版 frontmatter */
  /** 角色：入口 / 节（被入口 include）/ 片段（只被引用）——由 `_system.md` 的 include 推导 */
  role: z.enum(["entry", "section", "fragment"]),
  /** 片段模版（不进节拼接，供其它变量渲染，如 _chain.md） */

  status: z.enum(["builtin", "overridden"]),
  current: z.string(),
  builtin: z.string(),
  baseVersion: z.number().nullable(),
  stale: z.boolean(),
});
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

/** 系统上下文装配结果（真发与预览共用） */
export const AssembledSystemSchema = z.object({
  system: z.string(),
  unknownVars: z.array(z.string()),
  overBudget: z.object({ used: z.number(), budget: z.number() }).nullable(),
  /** 环境级告警（如未注入 DIY_CLI）：提示词会失真，但不算用户操作错误 */
  warnings: z.array(z.string()),
});
export type AssembledSystem = z.infer<typeof AssembledSystemSchema>;

/** 试验场预览响应 = 装配结果 + 仿真请求体 */
export const RequestPreviewSchema = AssembledSystemSchema.extend({
  requestBody: z.record(z.string(), z.unknown()).nullable(),
  requestNote: z.string(),
});
export type RequestPreview = z.infer<typeof RequestPreviewSchema>;
