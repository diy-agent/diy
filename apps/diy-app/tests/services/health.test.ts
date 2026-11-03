// tests/services/health.test.ts

import { describe, it, expect } from "vitest";
import { runHealthCheck } from "../../src/main/services/health";

describe("runHealthCheck", () => {
  it("在空目录返回 info 级别问题", () => {
    const issues = runHealthCheck();
    const _codes = issues.map((i) => i.code);
    // 新目录没有 state.yaml 和 task/，返回 info
    const infos = issues.filter((i) => i.severity === "info");
    expect(infos.length).toBeGreaterThanOrEqual(1);
  });
});
