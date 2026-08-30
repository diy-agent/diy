// tests/cli.intent.doctor.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 doctor（健康自检）CLI 契约测试（JSON 模式）
//
// 在隔离环境下验证 doctor 如实反映数据目录状态：
// 无 state.yaml / 无 projects/ 时，应返回对应缺失提示且 healthy=false。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

let sh: ShellTest;
let HOME: string;
let electron: ElectronTest;

beforeAll(async () => {
  electron = await startElectronTest();
  HOME = electron.home;
  sh = new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } });
});

afterAll(async () => {
  await electron?.stop();
});

describe("doctor", () => {
  it("返回 pid / home / state_exists / issues / healthy 完整字段", async () => {
    await sh.assertJson("./diy.sh doctor", {
      ok: true,
      data: {
        status: "ok",
        data: {
          pid: "*",
          home: HOME,
          state_exists: "*",
          healthy: "*",
        },
      },
    });
  });

  it("隔离环境无 state.yaml、无 projects/ → state_exists=false 且报出缺失提示", async () => {
    await sh.assertJson("./diy.sh doctor", {
      ok: true,
      data: {
        status: "ok",
        data: {
          pid: "*",
          home: HOME,
          state_exists: false,
          healthy: false,
          issues: ["state.yaml 不存在*", "projects/*"],
        },
      },
    });
  });
});