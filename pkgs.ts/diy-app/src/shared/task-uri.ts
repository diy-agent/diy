// src/shared/task-uri.ts
// 🎯 任务 URI 解析的**唯一实现**（纯函数，main 与 renderer 共用）。
//
// 为什么单独抽：历史上 renderer 用 /^projects\/(\d+)\/tasks\/\d+$/、main 用 /^projects\/([^/]+)\/tasks\//。
// 两份正则口径不同 → 非数字 project id 在 renderer 侧静默退化成空串，保存时把覆盖写进
// $DIY_HOME/projects/template（而不是 <pid>/template）。契约只有一份才不会漂移。

/** 形如 projects/<pid>/tasks/<tid> */
export const TASK_URI_RE = /^projects\/([^/]+)\/tasks\/([^/]+)$/;

/** 从任务 URI 推导 project id；非法/不匹配返回空串（调用方自行决定如何报错） */
export function projectFromUri(uri: string): string {
  const m = uri.match(/^projects\/([^/]+)\/tasks\//);
  return m?.[1] ?? "";
}
