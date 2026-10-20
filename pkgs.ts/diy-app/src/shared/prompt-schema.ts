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
import { ReqlogSchema } from "./context/reqlog";
import { TASK_HEAD_FIELDS, type TaskHeadField } from "./task-head";

/** 头字段的 zod 形状：从 TASK_HEAD_FIELDS 派生（清单在 ./task-head，见该文件头注）*/
const TASK_HEAD_SHAPE = Object.fromEntries(
  TASK_HEAD_FIELDS.map((f) => [f.key, z.string().describe(f.desc)] as const),
) as { [K in TaskHeadField]: z.ZodString };

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
  /**
   * 角色：入口（_system.md）/ 节（被入口 include）/ 片段（独立模版，不在 system 装配里）。
   * 由入口的 include 列表**推导**，不手工维护。
   */
  role: z.enum(["entry", "section", "fragment"]),
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
 *   · `buildVarTree()` 派生出试验场「变量定义」view 的二维树（名字/类型 + 说明）
 *   · 装配时 `safeParse` 校验注入与契约是否漂移（漂移 → 上屏告警，不静默）
 * 注意：只放 schema/类型，禁止 import node:fs（renderer 会打进包）。
 */
export const AssembleGlobalsSchema = z.object({
  persona: z
    .object({
      name: z.string().describe("当前人物名"),
      instructions: z.string().describe("人物行为指令（空则不注入）"),
    })
    .describe("agent 人物"),
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
      // 任务头字段（含 title/state）：**清单不在此手抄**，从 shared/task-detail.ts 的
      // TASK_HEAD_FIELDS 派生（##322 review R3）—— 三处手抄必漏一处。它们是任务文件
      // frontmatter 的同一份；空串 = 文件头里没有这个键。
      ...TASK_HEAD_SHAPE,
      body: z.string().describe("正文（文件里 frontmatter 之后的部分，首尾空白已去）"),
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
  /**
   * 模版节的**渲染结果**（144「模版即节点」方向的第一步）。
   *
   * 为什么放进 globals：真发（Context Tree 投递）要的不只是 `persona` 的**值**，
   * 而是模版渲染出来的**整节文本** —— identity.md 里有身份行 + 人物行为指令，
   * rules.md 是行为规范，_guard.md 是保命契约（禁止自杀式命令）。它们不在这里，
   * 真发就一样不投（209 review P0-1：真发 system 里 persona/身份/<rules>/<guard> 全 false）。
   * 渲染结果进 globals 而不是在投递处另拼一段：投递构造保持**单一入口**（buildDelivery），
   * 页面结构树/规则表也能看见这三个节点（否则页面上会多出一段"无来源"的文本）。
   */
  identity: z.string().describe("身份节（identity.md 渲染结果：身份行 + 人物行为指令）"),
  rules: z.string().describe("规范节（rules.md 渲染结果）"),
  guard: z.string().describe("保命契约（_guard.md 渲染结果，模版锁定）"),
  /**
   * 真发请求的**流量日志**（用户 2026-10-15）。
   *
   * 为什么进变量树：「我自己的东西在哪、怎么找」是**稳定**信息（只在换天时变文件名），
   * 模型才能自查"我上一步到底发出去了什么"——上下文树主要是给模型**定位**信息用的。
   * **值只有 `file` 一个字段**；路径规则 / 定位命令 / 字段表全在 `.describe()` 里，
   * 派生进信封的 `help.reqlog`（值节点里禁出现解释性字段：一条信息只在一处，见 envelope.ts）。
   * 行号给不出来：那条记录是请求发出**之后**才落盘的（UI 侧由流量日志反查）。
   */
  reqlog: ReqlogSchema,
  /**
   * **房间上下文**（##377 第 26 刀）：这一轮该看到的房间成员 + 近期别人的发言。
   *
   * 为什么拆成 `members` / `recent` **两个原子单元**：runtime 的增量判定是
   * `renderedHash` **按 place 逐条比**（`shared/context/projection.ts`）—— 合成一个单元时，
   * 成员改个名就会把整段 recent 重发一遍 diff（白烧 token、把上下文变成高频消息流）。
   *
   * 为什么不是一段拼好的中文：值是**结构化数据**，拼装归模版层（信封由通用渲染器出 YAML）。
   * 拼好的话既没法裁、也没法 diff，还会退化成"与正文不可区分的机制文本"（压缩会当人话改写）。
   *
   * 缺席（`undefined`）= 这个任务没有房间（从没开过任务页、也没被投递过）⇒ 单人任务逐字不变。
   */
  room: z
    .object({
      members: z
        .object({
          roomId: z.string().describe("房间 id（本任务自己的房间 = 任务 URI；投递轮 = 来源房间）"),
          name: z.string().describe("房间显示名（任务房间 = #任务号；侧边栏房间 = 实例短名）"),
          list: z
            .array(
              z.object({
                id: z.string().describe("成员 id（可 @ 寻址的全式）"),
                name: z.string().describe("显示名（人物名 / 人名）"),
                key: z.string().describe("此刻真能打中的 @ 键（提示与解析同一份判据）"),
                main: z.boolean().describe("是否本任务自己的会话主人"),
              }),
            )
            .describe("房间成员（按人先 agent 后排序）"),
        })
        .describe("房间成员：低频单元（谁在房里 / 别名 / 是否主人格；改成员才变）"),
      recent: z
        .object({
          items: z
            .array(
              z.object({
                from: z.string().describe("发言者的 @ 键"),
                at: z.string().describe("发言时刻（ISO）"),
                text: z.string().describe("发言正文"),
              }),
            )
            .describe("自上次以来**别人**的发言（时间正序；不含自己说的、不含正文里这一条）"),
          omitted: z.number().describe("因上限被省略的更早条数（>0 ⇒ 更早的没带进来）"),
        })
        .describe("房间近期发言：高频单元（有人说话就变；没有新发言时**整个单元缺席**）")
        .optional(),
    })
    .optional()
    .describe("房间上下文（没有房间时缺席）"),
});
export type AssembleGlobals = z.infer<typeof AssembleGlobalsSchema>;

/** 变量契约的扁平条目（引擎静态校验用；由 AssembleGlobalsSchema 派生） */
export interface VarSpec {
  path: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  desc?: string;
  /** 该路径**可能缺席**（schema 里是 `.optional()`，或祖先可选）—— 校验器据此放过"没有这个键" */
  optional?: boolean;
}

/** 渲染结构 trace 节点（试验场「模版结构树」：每个节点的产出字节 + :if 真假原因 + 迭代次数） */
export type TraceNode = {
  kind: string;
  /** 节点显示名：:if / :for / include / 标签 / 插值 / 文本 / 迭代项 */
  name?: string;
  /** 参数 = 模版里写的（表达式、relpath、字面文本片段） */
  arg?: string;
  /** 值 = 参数求值后的单行紧凑文本 */
  value?: string;
  bytes: number;
  /** 所属模版 body 里的源码区间（点模版结构树 → 高亮模版） */
  src?: { from: number; to: number };
  /** 渲染结果里的字符区间（点模版结构树 → 高亮预览） */
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
