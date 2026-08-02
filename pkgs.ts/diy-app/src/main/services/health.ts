// src/main/services/health.ts
// 🎯 健康检查服务

import { existsSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../core/state";

export interface HealthIssue {
  readonly code: string;
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
  readonly detail: string;
}

/** 运行健康检查 */
export function runHealthCheck(): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const home = diyHome();

  // state.yaml 存在
  const statePath = join(home, "state.yaml");
  if (!existsSync(statePath)) {
    issues.push({
      code: "NO_STATE",
      severity: "info",
      message: "state.yaml 不存在（首次启动会自动创建）",
      detail: statePath,
    });
  }

  // data root 可写
  const taskDir = join(home, "task");
  if (!existsSync(taskDir)) {
    issues.push({
      code: "NO_TASK_DIR",
      severity: "info",
      message: "task/ 目录不存在（首次操作会自动创建）",
      detail: taskDir,
    });
  }

  return issues;
}
