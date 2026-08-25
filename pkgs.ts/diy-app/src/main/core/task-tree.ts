// src/main/core/task-tree.ts
// 🎯 从磁盘构建任务树 + 父子链接 + 文本渲染
//    纯函数，读文件系统，无全局状态

import { existsSync, readdirSync, readlinkSync, statSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome, parseTaskFile, isStarred, loadState } from "./state";
import { TaskNode } from "./tree-format";

// ═══════════════════════════════════════
// 内部：扫描单个任务文件 → TaskNode
// ═══════════════════════════════════════

function readTaskNode(uri: string, starred: boolean): TaskNode | null {
  const agPath = join(diyHome(), "task", uri, "AGENTS.md");
  if (!existsSync(agPath)) return null;
  const raw = readFileSync(agPath, "utf-8");
  const meta = parseTaskFile(raw);
  if (!meta) return null;

  return {
    kind: "task",
    uri,
    title: meta.title,
    state: meta.state,
    project: meta.project,
    parentUri: meta.parent,
    detail: meta.detail,
    body: meta.body,
    created: meta.created,
    updated: meta.updated,
    starred,
    children: [],
  };
}

// ═══════════════════════════════════════
// 构建任务树
// ═══════════════════════════════════════

/**
 * 从磁盘加载任务树。
 * allTasks=true 时扫描全部 task/ 目录；
 * 默认只加载 star 过的任务（用户关注视图）。
 */
export function loadTaskTree(allTasks = false): TaskNode[] {
  const { projects } = loadState();
  const starDir = join(diyHome(), "star");
  const taskRoot = join(diyHome(), "task");

  const allByProject = new Map<string, TaskNode[]>();

  if (allTasks) {
    // 全部模式：扫描 task/ 下所有 AGENTS.md
    if (!existsSync(taskRoot)) return buildResult(allByProject, projects);

    scanAllDirs(taskRoot, "", allByProject);
  } else {
    // Star 模式：从 ~/.diy/star/ symlink 收集
    if (!existsSync(starDir)) return buildResult(allByProject, projects);

    for (const link of readdirSync(starDir)) {
      const linkPath = join(starDir, link);
      if (!lstatSync(linkPath).isSymbolicLink()) continue;

      // symlink target = task/ 下的相对路径
      const target = readlinkSync(linkPath);
      // 从 taskRoot 中提取相对 URI
      const relTarget = target.startsWith(taskRoot + "/")
        ? target.slice(taskRoot.length + 1)
        : target;

      const node = readTaskNode(relTarget, true);
      if (!node) continue;

      const pid = node.project ?? "unknown";
      const list = allByProject.get(pid) ?? [];
      list.push(node);
      allByProject.set(pid, list);
    }
  }

  return buildResult(allByProject, projects);
}

/**
 * 递归扫描 task/ 下所有 URIs（跨两层：type/xxx）
 */
function scanAllDirs(dir: string, prefix: string, result: Map<string, TaskNode[]>): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (!statSync(fullPath).isDirectory()) continue;

    const subPrefix = prefix ? `${prefix}/${entry}` : entry;
    const agPath = join(fullPath, "AGENTS.md");

    if (existsSync(agPath)) {
      // 这是一个任务目录
      const starred = isStarred(subPrefix);
      const node = readTaskNode(subPrefix, starred);
      if (node) {
        const pid = node.project ?? "unknown";
        const list = result.get(pid) ?? [];
        list.push(node);
        result.set(pid, list);
      }
    } else {
      // 继续递归
      scanAllDirs(fullPath, subPrefix, result);
    }
  }
}

/** 将按 project 分组的任务组装为 TaskNode[]，构建父子链接后返回。 */
function buildResult(
  byProject: Map<string, TaskNode[]>,
  projects: Map<string, { label?: string }>,
): TaskNode[] {
  const result: TaskNode[] = [];

  // 先遍历已注册的 projects（保持排序）
  for (const [pid, info] of projects) {
    const children = byProject.get(pid) ?? [];
    const linked = buildParentLinks(children);
    result.push({
      kind: "project",
      project: pid,
      title: info.label ?? pid,
      starred: false,
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
      starred: false,
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
