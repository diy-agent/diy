// src/main/core/project.ts
// 🎯 project 管理：创建、删除、查询。
//    project 是 task 的组织单元（替代历史 subject）。key = 短 id，
//    元数据（label/path/desc/state）存 state.yaml projects map。

import { loadState, saveState, norm } from "./state";
import type { ProjectInfo } from "./state";

/** 创建或更新 project */
export function createProject(
  id: string,
  opts: { label?: string; path?: string; desc?: string; state?: string } = {},
): void {
  if (!id || id.trim().length === 0) {
    throw new Error("project id 不能为空");
  }
  const state = loadState();
  const existing = state.projects.get(id);
  state.projects.set(id, {
    label: opts.label ?? existing?.label,
    path: opts.path ? norm(opts.path) : existing?.path,
    desc: opts.desc ?? existing?.desc,
    state: opts.state ?? existing?.state,
  });
  saveState({ projects: state.projects });
}

/** 删除 project（幂等） */
export function removeProject(id: string): void {
  const state = loadState();
  state.projects.delete(id);
  saveState({ projects: state.projects });
}

/** 列出所有 project */
export function listProjects(): Array<{ id: string; info: ProjectInfo }> {
  const state = loadState();
  return [...state.projects.entries()].map(([id, info]) => ({ id, info }));
}

/** project 是否存在（task create 校验用） */
export function projectExists(id: string): boolean {
  return loadState().projects.has(id);
}