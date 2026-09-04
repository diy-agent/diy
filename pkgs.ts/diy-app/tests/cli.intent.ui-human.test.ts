// tests/cli.intent.ui-human.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ui 人类点击顺序意图测试 — 经 CLI diy.ui.* 驱动 renderer（与 App 按钮共用入口）
//
// 理念：UI 意图测试面向我们自己 diy 的 ui.* 命令（不是外部浏览器自动化）。
// ui.* 命令走的是 renderer 里与真按钮同一入口（createProjectViaUi / createTaskViaUi），
// 发布后 agent 可直接执行同一命令操作 app UI。故意图测试按「人类点击 app」顺序编排：
//   setup  —— 点左侧导航「任务树」→ 点「创建项目」→ 填路径 → 提交（fixture 就位）
//   测试1  —— 在 fixture 已有 project 上点「＋」→ 填标题 → 提交 → ui tree 反向验证层级
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

let sh: ShellTest;
let HOME: string;
let electron: ElectronTest;

// fixture 在 setup 用例建立，测试1 复用
let fixtureProj = "";

beforeAll(async () => {
  electron = await startElectronTest();
  HOME = electron.home;
  sh = new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } });
});

afterAll(async () => {
  // ui 域无删除命令，清理走 main 直删
  if (fixtureProj) {
    try { await sh.run(`./diy.sh project remove ${fixtureProj}`); } catch { /* 清理尽力而为 */ }
  }
  await electron?.stop();
});

/** ui.tree 返回结构化节点数组，递归收集可读文本供断言 */
function collectText(nodes: any[], acc: string[] = []): string[] {
  for (const n of nodes ?? []) {
    if (n?.title) acc.push(String(n.title));
    if (n?.uri) acc.push(String(n.uri));
    if (n?.children) collectText(n.children, acc);
  }
  return acc;
}

async function treeText(): Promise<string> {
  const res = await sh.getJson("./diy.sh ui tree");
  return collectText((res.data as any)?.data ?? []).join("\n");
}

describe("ui 人类点击顺序（CLI diy.ui.*，agent 可复用）", () => {
  // setup: task fixture 就位 — 点导航进任务视图 + 点创建项目
  it("setup: 点导航进任务视图 → 点创建项目（fixture 就位）", async () => {
    // ① 点击左侧导航「任务树」（= ui.page.navigate，渲染进程 state 切换）
    await sh.assertJson("./diy.sh ui page navigate task", { ok: true, data: { status: "ok" } });

    // ② 点击「创建项目」→ 填路径 → 提交（= ui.project.create，与按钮共用 createProjectViaUi）
    const repo = `${HOME}/uihuman`;
    const r = await sh.getJson(`./diy.sh ui project create ${repo} --label UI演示项目`);
    fixtureProj = String((r.data as any)?.data?.id);
    expect(fixtureProj).toMatch(/^\d+$/);

    // 反向验证项目已显示在任务树
    expect(await treeText()).toContain("UI演示项目");
  });

  // 测试1: 任务创建 — 在 fixture 已有 project 上点 ＋ → 填标题 → 提交
  it("测试1: 点击项目 ＋ 建任务 → 任务树显示", async () => {
    // ③ 点击项目行「＋」→ 填标题 → 提交（= ui.task.create，与按钮共用 createTaskViaUi）
    const r = await sh.getJson(`./diy.sh ui task create 编写意图测试 ${fixtureProj}`);
    const uri = String((r.data as any)?.data?.uri);
    expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);

    // ④ ui.tree 反向验证新任务出现在任务树（层级归属）
    expect(await treeText()).toContain("编写意图测试");
  });
});
