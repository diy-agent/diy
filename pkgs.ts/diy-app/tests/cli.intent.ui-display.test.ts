// tests/cli.intent.ui-display.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 cli→ui 显示链路验证 — core 创建的数据经 UI 取数路径可见
//
// 走法：diy <创建>（main/core 写数据）→ diy ui tree（CLI → renderer 反向调 main
//   取树再渲染文本），验证创建的项目/任务出现在 UI 视图里。
// 每条用例自建自删，只断言自己那一条数据。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
  sh: ShellTest;
  HOME: string;
  electron: ElectronTest;
}

let fx: ElectronFixture;

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
});

afterAll(async () => {
  await fx?.electron?.stop();
});

/** 取 UI 树文本（renderer 域命令，反向调 main 取数据再渲染） */
async function treeText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui tree");
  return String((res.data as any)?.data ?? "");
}

describe("ui display — core 创建的数据在 UI 树可见", () => {
  it("project create 后，ui tree 显示该项目节点", async () => {
    const repo = `${fx.HOME}/ui-p`;
    const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label UI项目`);
    const id = String((r.data as any)?.data?.id);

    expect(await treeText()).toContain("UI项目");

    await fx.sh.run(`./diy.sh project remove ${id}`);
  });

  it("project + task create 后，ui tree 显示项目及其任务", async () => {
    const repo = `${fx.HOME}/ui-t`;
    const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label UI任务项目`);
    const pid = String((r.data as any)?.data?.id);
    await fx.sh.run(`./diy.sh task create 界面可见任务 ${pid}`);

    const text = await treeText();
    expect(text).toContain("UI任务项目");
    expect(text).toContain("界面可见任务");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  });
});