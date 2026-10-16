// src/shared/task-detail.ts
// 🎯 任务详情载荷的**唯一契约源**（纯 zod，无 node 依赖）：main 的 getTask 与 renderer 共用一份。
//
// 为什么必须单一真源（这是真踩过的 bug，不是洁癖）：
//   `diy.getTask` 的载荷此前由两处**各自手抄**字段清单 —— handler 里逐个列字段、
//   output schema 里再列一遍白名单。两处漏一处就静默出错：RPC 输出经 zod schema strip，
//   契约里没登记的字段在 renderer 侧变成 undefined，界面显示"未设置"，而数据其实好好的。
//   实测漏过 prior 的 change_type / module / priority（详情面板一直显示 —）与 persona
//   （界面显示缺省人物，跟后端实际用的模型对不上）。人的记性不可靠，让"加字段"只改一处：
//   本 schema + 声明该字段就够，handler 直接 `TaskDetailSchema.parse({...})`（多余键自动剥掉）。
//
// 约定：本文件只放 schema/类型，禁止 import node:*（renderer 会打进包）。

import { z } from "zod";
import { TaskStateSchema } from "../main/core/task-state";

/** 草稿字段名白名单 — 单一真相源 core/drafts.ts 的 DRAFT_FIELDS */
export const DraftFieldSchema = z.enum(["title", "body", "agent_input"]);
/** 草稿字段映射（值一律字符串，原样保存不 trim；partial：未编辑的字段不出现） */
export const DraftFieldsSchema = z.partialRecord(DraftFieldSchema, z.string());

/** 草稿数据（含 meta，供 renderer 判定过期 / CLI 观察） */
export const DraftsData = z.object({
  base_updated: z.string().optional(),
  saved: z.string().optional(),
  fields: DraftFieldsSchema,
});
export type Drafts = z.infer<typeof DraftsData>;

/**
 * 任务详情载荷（getTask 的 data）。
 *
 * 读侧一律宽容：结构化字段用 z.string() 而非词表枚举 —— 历史手写的值（如 priority: high）
 * 不在词表内也要能显示，枚举校验只发生在**写入侧**（task.create / task.edit 的 input）。
 * 全部 optional：任务文件是用户可编辑的，字段可以被删掉，读侧不该因此报错。
 */
export const TaskDetailSchema = z.object({
  uri: z.string(),
  title: z.string().optional(),
  state: TaskStateSchema.optional(),
  project: z.string().optional(),
  /** 项目路径/显示名（main 回填：project 字段只存 id） */
  project_path: z.string().optional(),
  project_label: z.string().optional(),
  parent: z.string().optional(),
  body: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  change_type: z.string().optional(),
  module: z.string().optional(),
  priority: z.string().optional(),
  /** agent 人物名：本任务由哪个「人物」干活（决定模型/参数/行为指令，见 shared/persona.ts） */
  persona: z.string().optional(),
  /**
   * 文件头原件（frontmatter 的**未过滤**解析结果，含本系统不认识的键）—— 与磁盘上
   * `AGENTS.md` 的 `---…---` 是同一份（见 core/state.ts 的 TaskData.frontmatter）。
   * 上面那些具名字段是它的**投影**，不是权限白名单：读侧显式给出头，写侧才有「传整份文件 → 剥头」的对称。
   */
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /** 未提交草稿：renderer 用它恢复编辑态与输入框（见 core/drafts.ts） */
  ui_drafts: DraftsData.nullable().optional(),
  /**
   * 该任务**是否与 agent 对话过**（##355 的「干净任务」态）。
   * 真源 = 会话 Op 日志存在且非空（main/core/local-paths.ts 的 hasConversation）——
   * 与任务树节点上的同名字段是**同一个判据**，两处都从 main 侧算，渲染端不猜。
   */
  has_session: z.boolean().optional(),
  /** 该任务是否有未发送的草稿（##355 的「有草稿」态；真源同 `ui_drafts`，这里只给"有没有"） */
  has_draft: z.boolean().optional(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
