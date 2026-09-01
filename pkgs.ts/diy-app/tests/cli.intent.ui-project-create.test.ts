// tests/cli.intent.ui-project-create.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ui → project 创建链路验证 — 经 renderer 真实入口创建并显示
//
// CLI 的 diy.ui.project.create 走 renderer 处理器（与 App 里「创建项目」
// 按钮共用 createProjectViaUi）：反向调 main 写数据 → 刷新树 → toast。
// 这里验证：CLI 驱动该 renderer 入口创建项目，且 UI 树（反向取数）能看到它。
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

/** 取 UI 树结构；ui.tree 返回结构化节点数组，递归收集可读文本供断言 */
function collectText(nodes: any[], acc: string[] = []): string[] {
  for (const n of nodes ?? []) {
    if (n?.title) acc.push(String(n.title));
    if (n?.uri) acc.push(String(n.uri));
    if (n?.children) collectText(n.children, acc);
  }
  return acc;
}

async function treeText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui tree");
  return collectText((res.data as any)?.data ?? []).join("\n");
}

describe("ui project create", () => {
  it("经 renderer 入口创建项目 → ui tree 可见（与 App 按钮同一逻辑）", async () => {
    const repo = `${fx.HOME}/uip`;
    const r = await fx.sh.getJson(`./diy.sh ui project create ${repo} --label UI创建`);
    const id = String((r.data as any)?.data?.id);
    expect(id).toMatch(/^\d+$/);

    expect(await treeText()).toContain("UI创建");

    // 清理（ui 无删除入口，走 main 直删）
    await fx.sh.run(`./diy.sh project remove ${id}`);
  });
});