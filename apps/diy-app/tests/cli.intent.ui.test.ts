// tests/cli.intent.ui.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 UI 域 CLI 契约测试 — 具体功能验证（JSON 模式）
//
// ui.* 是 renderer 域命令：CLI 经 RPC 转发到真实 renderer 行程。
// 无 GUI 回拨时（headless 隔离运行）回调不触发，仅验证命令返回状态契约。
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

describe("ui status", () => {
  it("返回主进程的 pid / uptime / memory", async () => {
    await sh.assertJson("./diy.sh ui status", {
      ok: true,
      data: { status: "ok", data: { pid: "*", uptime: "*", memory: "*" } },
    });
  });
});

describe("ui tree", () => {
  it("返回任务树文本", async () => {
    await sh.assertJson("./diy.sh ui tree", {
      ok: true,
      data: { status: "ok", data: "*" },
    });
  });
});

describe("ui page navigate", () => {
  it("切换页面返回 ok（无 GUI 时导航回调不触发）", async () => {
    await sh.assertJson("./diy.sh ui page navigate task", {
      ok: true,
      data: { status: "ok" },
    });
  });
});

describe("ui page focus", () => {
  it("选中任务返回 ok（无 GUI 时聚焦回调不触发）", async () => {
    await sh.assertJson("./diy.sh ui page focus local/abc", {
      ok: true,
      data: { status: "ok" },
    });
  });
});

describe("ui page toast", () => {
  it("弹通知返回 ok（无 GUI 时通知回调不触发）", async () => {
    await sh.assertJson("./diy.sh ui page toast 测试消息 --level info", {
      ok: true,
      data: { status: "ok" },
    });
  });
});