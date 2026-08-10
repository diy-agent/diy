// src/main/core/subject.ts
// 🎯 subject 管理：注册、删除、查询

import { loadState, saveState } from "./state";
import type { SubjectInfo } from "./state";

/** 注册或更新 subject */
export function addSubject(path: string, label?: string, desc?: string): void {
  if (!path || path.trim().length === 0) {
    throw new Error("路径不能为空");
  }
  const state = loadState();
  const existing = state.subjects.get(path);
  state.subjects.set(path, {
    label: label ?? existing?.label,
    desc: desc ?? existing?.desc,
  });
  saveState({ subjects: state.subjects });
}

/** 删除 subject */
export function removeSubject(path: string): void {
  const state = loadState();
  state.subjects.delete(path);
  saveState({ subjects: state.subjects });
}

/** 列出所有 subject */
export function listSubjects(): Array<{ path: string; info: SubjectInfo }> {
  const state = loadState();
  return [...state.subjects.entries()].map(([path, info]) => ({ path, info }));
}
