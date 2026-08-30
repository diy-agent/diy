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

  // data root 可写（项目数据目录）
  const projDir = join(home, "projects");
  if (!existsSync(projDir)) {
    issues.push({
      code: "NO_PROJECT_DIR",
      severity: "info",
      message: "projects/ 目录不存在（首次创建项目会自动创建）",
      detail: projDir,
    });
  }

  return issues;
}
