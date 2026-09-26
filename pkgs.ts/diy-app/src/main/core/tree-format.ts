// src/main/core/tree-format.ts
// 🎯 任务树纯类型 + 文本渲染（无 node 依赖，main 与 renderer 共用）
//    纯类型与纯函数，浏览器安全，可被 renderer 进程安全 import。

/** 任务状态 — 单一真相源 task-state.ts */
export type { TaskState } from "./task-state";
import type { TaskState } from "./task-state";

/** 任务树节点（纯数据，无 I/O） */
export interface TaskNode {
  kind: "project" | "task";
  uri?: string;
  /** 任务号 = uri 末段（projects/<pid>/tasks/<tid> 的 tid）。
   *  项目内自增、从 1 起，**仅项目内唯一**（跨项目会重号）—— 展示层一律带项目分组用，
   *  不要拿它当全局标识去索引（全局标识是 uri）。 */
  num?: string;
  title?: string;
  state?: TaskState;
  /** 所属 project id（task 节点） */
  project?: string;
  /** 所属 project 路径/展示名（task 节点由 task-tree 回填；project 节点为自身路径）。
   *  显示规则：home 内显示 ~/…，之外显示绝对路径 —— 与 state.ts norm() 一致，
   *  值来自 projects/<id>/meta.yaml，展示层直接用，不再各处展开。 */
  project_path?: string;
  project_label?: string;
  parentUri?: string;
  body?: string;
  created?: string;
  updated?: string;
  /** 变更性质（词表见 task-fields.ts）；缺省 = 未设置。读侧 string，写入侧才做枚举校验 */
  change_type?: string;
  /** 模块（`/` 分层自由字符串）；缺省 = 未设置 */
  module?: string;
  /** 优先级 P0-P3；缺省 = 未定级 */
  priority?: string;
  children: TaskNode[];
}

// ═══════════════════════════════════════
// 文本渲染（CLI 输出用）
// ═══════════════════════════════════════

/** 将任务树渲染为缩进文本 */
export function renderTreeText(nodes: TaskNode[], indent = ""): string {
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.kind === "project") {
      lines.push(`${indent}📁 ${n.title}`);
    } else {
      const title = n.title ? ` ${n.title}` : "";
      const num = n.num ? `#${n.num} ` : "";
      lines.push(`${indent}  ${num}${n.uri}${title}`);
    }
    if (n.children.length > 0) {
      lines.push(renderTreeText(n.children, indent + "  "));
    }
  }
  return lines.join("\n");
}
