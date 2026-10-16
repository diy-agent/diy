// tests/cli.intent.ui.task-delete.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 删除链路验证（##352）— 走 renderer 真实入口（CLI 驱动，同人类点「🗑」一套逻辑）
//
// 全部通过 CLI 的 diy.ui.* 驱动（renderer 域），与任务树行内的「🗑」按钮共用
// deleteTaskViaUi / removeProjectViaUi（renderer_solid/lib/delete-entry.ts）：
//   diy ui task delete <uri>    = 点任务行「🗑」→ 确认弹窗「删除」
//   diy ui project remove <id>  = 点项目行「🗑」→ 确认弹窗「删除」
//
// 断言落在**两处**：ui tree（界面上真的没了）+ 磁盘（数据真的删了）。
// 只测界面会漏掉「只从界面消失、数据还在」这类假删除。
//
// 不在本测试范围：ConfirmDialog 二次确认本身是 UI 交互（弹窗文案 / 默认焦点在「取消」/
// 点「删除」才真删）—— 那一步 CLI 入口不经过，由 CDP 手工验证（见 ##352 落地记录）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

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

/** 任务本体是否在磁盘上（uri 就是相对 DIY_HOME 的路径：projects/<pid>/tasks/<tid>） */
function taskFileExists(uri: string): boolean {
  return existsSync(join(fx.HOME, uri, "AGENTS.md"));
}

/** UI 树里可见的全部 title / uri（renderer 域反向取数，走真实 RPC 往返） */
async function treeText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui tree");
  const acc: string[] = [];
  const walk = (nodes: any[]): void => {
    for (const n of nodes ?? []) {
      if (n?.title) acc.push(String(n.title));
      if (n?.uri) acc.push(String(n.uri));
      walk(n?.children ?? []);
    }
  };
  walk((res.data as any)?.data ?? []);
  return acc.join("\n");
}

/** 经 renderer 入口建任务（= 点项目行「＋」/ 任务行「＋」） */
async function createTaskViaUi(title: string, pid: string, parentUri?: string): Promise<string> {
  const parentArg = parentUri ? ` -p ${parentUri}` : "";
  const r = await fx.sh.getJson(`./diy.sh ui task create ${title} ${pid}${parentArg}`);
  return String((r.data as any)?.data?.uri);
}

describe("ui 删除入口（##352）", () => {
  it("ui task delete：任务从树与磁盘消失；子任务不随删（失父升为一级）", async () => {
    const p = await fx.sh.getJson(`./diy.sh ui project create ${fx.HOME}/ui-del-task --label UI删除任务`);
    const pid = String((p.data as any)?.data?.id);

    const parentUri = await createTaskViaUi("被删父任务", pid);
    const childUri = await createTaskViaUi("幸存子任务", pid, parentUri);
    expect(parentUri).toMatch(/^projects\/\d+\/tasks\/\d+$/);
    expect(taskFileExists(parentUri)).toBe(true);
    expect(taskFileExists(childUri)).toBe(true);

    const r = await fx.sh.getJson(`./diy.sh ui task delete ${parentUri}`);
    expect(r.ok).toBe(true);

    // 树读取走 renderer→main 往返，负载高时慢一拍 → 有界轮询（慢与错分开）
    const t = await waitUntil(
      treeText,
      (x) => !x.includes("被删父任务") && x.includes("幸存子任务"),
      { label: "ui tree 里父任务消失、子任务仍在" },
    );
    expect(t).not.toContain("被删父任务");
    expect(t).toContain("幸存子任务");

    // 磁盘：父真删、子真留（父任务目录是 rmSync，子任务目录与它并列，不随删）
    expect(taskFileExists(parentUri)).toBe(false);
    expect(taskFileExists(childUri)).toBe(true);
  });

  it("ui project remove：项目及其任务从树与磁盘一起消失", async () => {
    const p = await fx.sh.getJson(`./diy.sh ui project create ${fx.HOME}/ui-del-proj --label UI删除项目`);
    const pid = String((p.data as any)?.data?.id);
    const uri = await createTaskViaUi("项目内任务", pid);
    expect(taskFileExists(uri)).toBe(true);

    const r = await fx.sh.getJson(`./diy.sh ui project remove ${pid}`);
    expect(r.ok).toBe(true);

    const t = await waitUntil(treeText, (x) => !x.includes("UI删除项目"), { label: "ui tree 里项目消失" });
    expect(t).not.toContain("UI删除项目");
    // 数据目录（含其全部任务）整体消失
    expect(existsSync(join(fx.HOME, "projects", pid))).toBe(false);
  });
});
