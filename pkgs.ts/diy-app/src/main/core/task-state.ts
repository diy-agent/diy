// src/main/core/task-state.ts
// 🎯 任务状态单一真相源：TASK_STATES 数组 → TaskState 类型 + TaskStateSchema
//    纯数据 + zod schema，无 Node 依赖，main 与 renderer 可安全共享。
//    新增/删除状态时只需改 TASK_STATES 一处。

import { z } from "zod";

export const TASK_STATES = [
  "pending",
  "active",
  "done",
  "cancelled",
  "blocked",
  "shelved",
  "new",
  "open",
  "closed",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TaskStateSchema = z.enum(TASK_STATES);

/** 任务状态 → DaisyUI 圆点颜色 class（单一真相源，所有组件从此处取色） */
export const TASK_STATE_COLORS: Record<string, string> = {
  pending: "bg-warning",
  active: "bg-info",
  done: "bg-success",
  blocked: "bg-error",
  cancelled: "bg-neutral",
  shelved: "bg-neutral",
  new: "bg-accent",
  open: "bg-info",
  closed: "bg-neutral",
};

/** 取任务状态的圆点颜色 class（未知状态退化 bg-info） */
export function taskStateColor(state: string | undefined): string {
  return TASK_STATE_COLORS[state ?? ""] ?? "bg-info";
}
