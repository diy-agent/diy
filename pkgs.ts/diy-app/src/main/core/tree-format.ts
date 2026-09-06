// src/main/core/tree-format.ts
// 🎯 任务树纯类型 + 文本渲染（无 node 依赖，main 与 renderer 共用）
//    纯类型与纯函数，浏览器安全，可被 renderer 进程安全 import。

/** 任务状态（与 state.ts 保持一致） */
export type TaskState =
  | "pending"
  | "active"
  | "done"
  | "cancelled"
  | "blocked"
  | "shelved"
  | "new"
  | "open"
  | "closed";

/** 任务树节点（纯数据，无 I/O） */
export interface TaskNode {
  kind: "project" | "task";
  uri?: string;
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
  detail?: string;
  body?: string;
  created?: string;
  updated?: string;
  starred: boolean;
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
      const star = n.starred ? " ⭐" : "";
      const title = n.title ? ` ${n.title}` : "";
      lines.push(`${indent}  ${n.uri}${title}${star}`);
    }
    if (n.children.length > 0) {
      lines.push(renderTreeText(n.children, indent + "  "));
    }
  }
  return lines.join("\n");
}
