/**
 * shared/task-node.ts — 任务树节点（递归 schema）
 *
 * 2026-11-06 从 api-def.ts 提出：task 与 ui 两个域都用它。
 */
import { z } from "zod";
import { TaskStateSchema } from "../main/core/task-state";

export interface TaskNodeShape {
  kind: "project" | "task";
  uri?: string;
  /** 任务号 = uri 末段（项目内自增）。列表默认按它对同级排序，故必须在契约里 */
  num?: string;
  title?: string;
  state?: string;
  project?: string;
  /** 项目路径/显示名（main 的 task-tree 回填；运行时输出一直有，类型此前漏了） */
  project_path?: string;
  project_label?: string;
  parentUri?: string;
  body?: string;
  created?: string;
  updated?: string;
  change_type?: string;
  module?: string;
  priority?: string;
  /**
   * 该任务**是否与 agent 对话过**（##355「干净任务」态；真源 = 会话 Op 日志存在且非空，
   * 见 core/local-paths.ts 的 hasConversation）。缺省 = 未算（旧载荷），读侧按"未知"处理。
   */
  has_session?: boolean;
  /** 该任务是否有**未发送的草稿**（##355「有草稿」态；真源 = 任务目录 .diy/drafts.yaml 的 agent_input） */
  has_draft?: boolean;
  children: TaskNodeShape[];
}
export const TaskNodeSchema: z.ZodType<TaskNodeShape> = z.lazy(() =>
  z.object({
    kind: z.enum(["project", "task"]),
    uri: z.string().optional(),
    num: z.string().optional(),
    title: z.string().optional(),
    state: TaskStateSchema.optional(),
    project: z.string().optional(),
    project_path: z.string().optional(),
    project_label: z.string().optional(),
    parentUri: z.string().optional(),
    body: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    // 刻意用 z.string() 而非 task-fields 的枚举：读侧一律宽容（历史手写值如 priority: high
    // 不在词表内也要能显示出来），枚举校验只发生在写入侧（task.create / task.edit 的 input）。
    change_type: z.string().optional(),
    module: z.string().optional(),
    priority: z.string().optional(),
    // agent 面状态（##355）：两枚逐任务布尔（判据见 TaskNodeShape 上的注释）。
    // 与上面的字段同样 optional —— 读侧宽容，缺了只是"这一项不知道"，不是错误。
    has_session: z.boolean().optional(),
    has_draft: z.boolean().optional(),
    children: z.array(TaskNodeSchema),
  }),
);
