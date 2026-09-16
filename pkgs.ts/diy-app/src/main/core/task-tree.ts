// src/main/core/task-tree.ts
// 🎯 从磁盘构建任务树 + 父子链接 + 文本渲染
//    纯函数，读文件系统，无全局状态
//    task 按项目聚合在 $DIY_HOME/projects/<pid>/tasks/<tid>/，
//    project 分组由 URI 路径推导（不再依赖 frontmatter project）。

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome, parseTaskFile, projectsRoot, projectFromUri } from "./state";
import { listProjects } from "./project";
import { TaskNode } from "./tree-format";

// ═══════════════════════════════════════
// 内部：扫描单个任务文件 → TaskNode
// ═══════════════════════════════════════

function readTaskNode(
  uri: string,
  preg: ReadonlyMap<string, { label?: string; path?: string }>,
): TaskNode | null {
  const agPath = join(diyHome(), uri, "AGENTS.md");
  if (!existsSync(agPath)) return null;
  const raw = readFileSync(agPath, "utf-8");
  const fm = parseTaskFile(raw);
  if (!fm) return null;

  const pid = projectFromUri(uri) || fm.project;
  const info = (pid && preg.get(pid)) || undefined;
  return {
    kind: "task",
    uri,
    // 任务号取 uri 末段（projects/<pid>/tasks/<tid> → tid），在 main 侧算一次，
    // 避免 UI/CLI 各自 split("/") 出偏差；uri 是权威，num 只是它的展示投影。
    num: uri.split("/").pop(),
    title: fm.title,
    state: fm.state,
    project: pid,
    project_path: info?.path,
    project_label: info?.label,
    parentUri: fm.parent,
    body: fm.body,
    created: fm.created,
    updated: fm.updated,
    children: [],
  };
}

// ═══════════════════════════════════════
// 构建任务树
// ═══════════════════════════════════════

/**
 * 从磁盘加载全部任务树（扫 projects/ 下所有 AGENTS.md）。
 */
export function loadTaskTree(): TaskNode[] {
  // 已注册项目（id → 显示名/路径），保持 id 数值排序
  const projects = new Map<string, { label?: string; path?: string }>();
  for (const p of listProjects()) projects.set(p.id, { label: p.info.label, path: p.info.path });

  const taskRoot = projectsRoot();
  const allByProject = new Map<string, TaskNode[]>();

  if (!existsSync(taskRoot)) return buildResult(allByProject, projects);

  scanAllDirs(taskRoot, "projects", allByProject, projects);

  return buildResult(allByProject, projects);
}

/**
 * 递归扫描 projects/ 下所有 URIs（跨多层：projects/<pid>/tasks/<tid>）
 */
function scanAllDirs(
  dir: string,
  prefix: string,
  result: Map<string, TaskNode[]>,
  preg: ReadonlyMap<string, { label?: string; path?: string }>,
): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (!statSync(fullPath).isDirectory()) continue;

    const subPrefix = prefix ? `${prefix}/${entry}` : entry;
    const agPath = join(fullPath, "AGENTS.md");

    if (existsSync(agPath)) {
      // 这是一个任务目录
      const node = readTaskNode(subPrefix, preg);
      if (node) {
        const pid = node.project ?? "unknown";
        const list = result.get(pid) ?? [];
        list.push(node);
        result.set(pid, list);
      }
    } else {
      // 继续递归
      scanAllDirs(fullPath, subPrefix, result, preg);
    }
  }
}

/** 将按 project 分组的任务组装为 TaskNode[]，构建父子链接后返回。 */
function buildResult(
  byProject: Map<string, TaskNode[]>,
  projects: Map<string, { label?: string; path?: string }>,
): TaskNode[] {
  const result: TaskNode[] = [];

  // 先遍历已注册的 projects（保持 id 数值排序）
  for (const [pid, info] of projects) {
    const children = byProject.get(pid) ?? [];
    const linked = buildParentLinks(children);
    result.push({
      kind: "project",
      project: pid,
      title: info.label ?? pid,
      project_path: info.path,
      project_label: info.label,
      children: linked,
    });
    byProject.delete(pid);
  }

  // 未注册 project 的孤儿任务
  for (const [pid, children] of byProject) {
    if (children.length === 0) continue;
    result.push({
      kind: "project",
      project: pid,
      title: pid,
      children: buildParentLinks(children),
    });
  }

  return result;
}

/**
 * 构建父子关系：将子任务从顶层移到父任务的 children 下。
 * 返回无父任务的任务列表（顶层任务）。
 */
function buildParentLinks(tasks: TaskNode[]): TaskNode[] {
  const byUri = new Map<string, TaskNode>();
  for (const t of tasks) byUri.set(t.uri ?? "", t);

  const result: TaskNode[] = [];
  for (const t of tasks) {
    const parentUri = t.parentUri;
    if (parentUri && byUri.has(parentUri)) {
      byUri.get(parentUri)!.children.push(t);
    } else {
      result.push(t);
    }
  }
  return result;
}

// ═══════════════════════════════════════
// 文本渲染（CLI 输出用）— 定义见 tree-format.ts，这里 re-export 保持兼容
// ═══════════════════════════════════════

export { renderTreeText } from "./tree-format";