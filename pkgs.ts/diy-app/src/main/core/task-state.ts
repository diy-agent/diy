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
