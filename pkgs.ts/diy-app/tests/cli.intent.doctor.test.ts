// tests/cli.intent.doctor.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 doctor（健康自检）CLI 契约测试（JSON 模式）
//
// 在隔离环境下验证 doctor 如实反映数据目录状态：
// 无 state.yaml / 无 projects/ 时，应返回对应缺失提示且 healthy=false。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// ═══════════════════════════════════════════════════════════════
// getAppInfo（设置页「状态」标签的数据源）
//
// 它原先只是主进程里一条 ipcMain.handle("getAppInfo")，preload 未桥接、api-def 未登记，
// 所以没有任何调用方能真正拿到数据（界面永远停在「加载中…」）。迁移到 RPC 后
// 用 CLI 就能验收 —— 三条入口（Electron / serve / CLI）共用同一实现。
// ═══════════════════════════════════════════════════════════════
describe("getAppInfo", () => {
  it("返回端口/目录/版本/系统全部字段，且目录落在隔离 HOME 下", async () => {
    await sh.assertJson("./diy.sh getAppInfo", {
      ok: true,
      data: {
        port: "*",
        diyHome: HOME,
        cache: `${HOME}/cache`,
        userData: `${HOME}/electron_user_data`,
        electron: "*",
        node: "*",
        chrome: "*",
        platform: "*",
        pid: "*",
        memory: "*total*",
      },
    });
  });

  it("port 是实际监听的 RPC 端口（非 0、非占位）", async () => {
    const r = await sh.getJson("./diy.sh getAppInfo");
    const port = Number((r as any).data?.port);
    expect(Number.isFinite(port) && port > 0).toBe(true);
  });
});