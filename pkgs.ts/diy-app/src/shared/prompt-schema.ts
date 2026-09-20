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
  /** 入口（_system.md）/ 节（被入口 include）：由入口的 include 列表推导，不手工维护 */
  role: z.enum(["entry", "section"]),
  status: z.enum(["builtin", "overridden"]),
  current: z.string(),
  builtin: z.string(),
  baseVersion: z.number().nullable(),
  stale: z.boolean(),
});
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

/** 技能条目（skills 的元素类型；命名供变量树显示为 [Skill]） */
export const SkillSchema = z
  .object({
    name: z.string().describe("技能名"),
    desc: z.string().describe("说明"),
  })
  .meta({ id: "Skill" });

/** AGENTS.md 链的一层（chain 的元素类型） */
export const ChainItemSchema = z
  .object({
    path: z.string().describe("AGENTS.md 路径"),
    scope: z.string().describe("生效目录"),
    content: z.string().describe("正文"),
  })
  .meta({ id: "ChainEntry" });

/**
 * 注入 globals 的**契约（单一真源）**：
 *   · `flattenVars()` 派生出引擎静态校验用的扁平 VarSpec[]
 *   · `buildVarTree()` 派生出试验场「可用变量」view 的二维树（名字/类型 + 说明）
 *   · 装配时 `safeParse` 校验注入与契约是否漂移（漂移 → 上屏告警，不静默）
 * 注意：只放 schema/类型，禁止 import node:fs（renderer 会打进包）。
 */
export const AssembleGlobalsSchema = z.object({
  diy: z
    .object({
      cli: z.string().describe("CLI 入口"),
      home: z.string().describe("数据根"),
    })
    .describe("diy 本体"),
  project: z
    .object({ path: z.string().describe("项目工作目录") })
    .describe("项目"),
  task: z
    .object({
      uri: z.string().describe("任务 URI"),
      title: z.string(),
      state: z.string().describe("状态"),
      body: z.string().describe("正文"),
      dir: z.string().describe("任务目录"),
    })
    .describe("当前任务"),
  cwd: z
    .object({
      path: z.string().describe("工具执行目录"),
      note: z.string().describe("回退原因"),
      isFallback: z.boolean().describe("是否已回退"),
      isTaskDir: z.boolean().describe("是否任务目录"),
      isAppDir: z.boolean().describe("是否 diy 仓库"),
    })
    .describe("工作目录与回退"),
  chain: z.array(ChainItemSchema).describe("AGENTS.md 链（逐层，用 :for 迭代）"),
  skills: z.array(SkillSchema).describe("技能清单（空则整节跳过）"),
});
export type AssembleGlobals = z.infer<typeof AssembleGlobalsSchema>;

/** 变量契约的扁平条目（引擎静态校验用；由 AssembleGlobalsSchema 派生） */
export interface VarSpec {
  path: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  desc?: string;
}

/** 渲染结构 trace 节点（试验场「结构树」：每个节点的产出字节 + :if 真假原因 + 迭代次数） */
export type TraceNode = {
  kind: string;
  /** 节点显示名：:if / :for / include / 标签 / 插值 / 文本 / 迭代项 */
  name?: string;
  /** 参数 = 模版里写的（表达式、relpath、字面文本片段） */
  arg?: string;
  /** 值 = 参数求值后的单行紧凑文本 */
  value?: string;
  bytes: number;
  /** 所属模版 body 里的源码区间（点结构树 → 高亮模版） */
  src?: { from: number; to: number };
  /** 渲染结果里的字符区间（点结构树 → 高亮预览） */
  out?: { from: number; to: number };
  result?: boolean;
  reason?: string;
  children?: TraceNode[];
};
export const TraceNodeSchema: z.ZodType<TraceNode> = z.lazy(() =>
  z.object({
    kind: z.string(),
    name: z.string().optional(),
    arg: z.string().optional(),
    value: z.string().optional(),
    bytes: z.number(),
    src: z.object({ from: z.number(), to: z.number() }).optional(),
    out: z.object({ from: z.number(), to: z.number() }).optional(),
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
  /** 本次**实际注入**的 globals 值（「变量值」view 的数据源；随任务/草稿变化） */
  values: z.record(z.string(), z.unknown()),
  /** 变量契约：宿主注入的变量清单（模版作者可用的"输入面"） */
  // 变量契约不再随载荷下发：renderer 直接从 AssembleGlobalsSchema 派生（单一真源，零漂移）
});
export type AssembledSystem = z.infer<typeof AssembledSystemSchema>;

/** 试验场预览响应 = 装配结果 + 仿真请求体 */
export const RequestPreviewSchema = AssembledSystemSchema.extend({
  requestBody: z.record(z.string(), z.unknown()).nullable(),
  requestNote: z.string(),
});
export type RequestPreview = z.infer<typeof RequestPreviewSchema>;
