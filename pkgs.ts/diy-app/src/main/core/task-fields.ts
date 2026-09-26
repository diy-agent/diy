// src/main/core/task-fields.ts
// 🎯 任务结构化字段单一真相源：change_type / module / priority
//    纯数据 + zod schema，无 Node 依赖，main 与 renderer 可安全共享。
//    新增/删除取值时只需改本文件一处（与 task-state.ts 同一模式）。
//
// ⚠️ 临时硬编码（明确的技术债，不是疏漏）：
//    diy 目前没有「扩展机制」，无法按项目定制任务字段。这些取值先硬编码在这里临时用，
//    待引入「项目自定义字段定义」机制后，本文件应降级为**内置默认值**，
//    由项目 meta 提供覆盖/扩展。届时调用方（表单/表格/排序）已面向本文件的常量编程，
//    换数据源只改本文件内部。

import { z } from "zod";

// ═══════════════════════════════════════
// change_type —— 变更性质
// ═══════════════════════════════════════

/**
 * 变更类型：**这次要做的是什么性质的改动**。
 *
 * 为什么叫 change_type 而不是 type：
 *   `type` 一词留给将来的**任务类型扩展机制**——那种 type 是扩展点，
 *   不同取值带不同字段集与生命周期（Jira 的 Epic / Story / Bug 即此类）。
 *   本字段只描述变更性质，是封闭词表，两者不是一回事，不能共用一个名字。
 *   同理不用 kind：TreeNode 的 `kind: "project" | "task"` 已占用该名。
 *
 * 为什么词表直接抄 Conventional Commits：
 *   用户的标题前缀本来就是 commit 风格（实测：feat/bug/chore/refactor…），
 *   抄词表即零学习成本。注意由此**不要用 bug**：commit 语境下缺陷修复写 fix，
 *   `bug` 属于上面说的任务类型（"这是个缺陷报告"），将来进 type 字段。
 */
export const CHANGE_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "chore",
  "build",
  "ci",
  "revert",
] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

export const ChangeTypeSchema = z.enum(CHANGE_TYPES);

// ═══════════════════════════════════════
// priority —— 优先级
// ═══════════════════════════════════════

/**
 * 优先级：P0 最高（阻塞/线上事故）… P3 最低。
 *
 * **字段缺省 = 未定级**（显示 "—"，排序排最末），不默认 P2：
 * 与 Linear / GitHub Projects 的 "No priority" 一致——不替用户猜。
 * 排序上 P0<P1<P2<P3 恰是字典序，无需额外权重表。
 */
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export type Priority = (typeof PRIORITIES)[number];

export const PrioritySchema = z.enum(PRIORITIES);

// ═══════════════════════════════════════
// module —— 模块
// ═══════════════════════════════════════

/**
 * module 建议清单（**只是建议，不禁止自由输入**：取值还在演化）。
 *
 * 允许 `/` 分层（`agent/ui`）——将来可按前缀聚合出轻量层级，
 * 从而减少对父子任务树的归类依赖（树只用来表达真实的分解关系，不再兼职分类）。
 *
 * 清单不是拍脑袋来的：由既有 111 条任务标题里的 scope 值收敛而来
 * （agent / agent-ui / agent-context / task / task-ui / nav / llm / cli …），
 * 其中 `agent-ui` → `agent/ui`。
 */
export const MODULES = [
  "agent",
  "agent/ui",
  "agent/context",
  "agent/tool",
  "agent/local",
  "task",
  "task/ui",
  "task/tree",
  "ui",
  "nav",
  "llm",
  "cli",
  "arch",
  "docs",
] as const;

/** module 最大长度（自由字符串，但要挡住粘贴整篇文章这类误用） */
export const MODULE_MAX_LENGTH = 60;
