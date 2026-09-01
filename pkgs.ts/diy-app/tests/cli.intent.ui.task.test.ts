// tests/cli.intent.ui.task.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 task 创建链路验证 — 走 renderer 真实入口（CLI 驱动，同人类点按钮一套逻辑）
//
// 全部通过 CLI 的 diy.ui.* 驱动（renderer 域），模拟人类点 app 的操作序列：
//   1. diy ui project create → 建项目（= 点「创建项目」按钮）
//   2. diy ui task create     → 建任务（= 点项目行「+」按钮 → 填表单 → 提交）
//   3. diy ui tree            → 取 UI 树，验证新任务出现在对应项目下
//
// 不用 diy task/project create（core 逻辑），保证走的是 renderer 入口——
// 同一套代码既可被 CLI 自动测试，也可作为 agent 实验性探测的入口。
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

/** 取 UI 树结构（renderer 域命令，反向调 main）；ui.tree 返回结构化节点数组 */
async function treeData(): Promise<any[]> {
  const res = await fx.sh.getJson("./diy.sh ui tree");
  return (res.data as any)?.data ?? [];
}

/** 建一个项目（走 renderer 入口，返回 id） */
async function createProjectViaUi(label: string): Promise<string> {
  const repo = `${fx.HOME}/ui-${label}`;
  const r = await fx.sh.getJson(`./diy.sh ui project create ${repo} --label ${label}`);
  return String((r.data as any)?.data?.id);
}

/** 清理：走 main 直删项目（ui 域无删除入口） */
async function cleanupProj(pid: string): Promise<void> {
  await fx.sh.run(`./diy.sh project remove ${pid}`);
}

/** 找某项目节点的直接子任务 title */
function childTitles(pid: string, nodes: any[]): string[] {
  const proj = nodes.find((n) => n?.project === pid);
  return (proj?.children ?? []).map((c: any) => c?.title ?? "");
}

describe("ui task — 经 renderer 入口创建任务（CLI 驱动，同人类点按钮一套逻辑）", () => {
  it("在已建项目下，经 ui 入口创建任务 → 树直接子级可见", async () => {
    // 1. 建项目（渲染入口）
    const pid = await createProjectViaUi("任务项目A");
    expect(pid).toMatch(/^\d+$/);

    // 2. 建任务（渲染入口，= 点「+」填表提交）
    const t = await fx.sh.getJson(`./diy.sh ui task create 界面任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    expect(uri).toBe(`projects/${pid}/tasks/1`);

    // 3. 验证树：任务出现在该项目节点的直接子级
    const titles = childTitles(pid, await treeData());
    expect(titles).toContain("界面任务");

    await cleanupProj(pid);
  });

  it("再建任务 → id 自增且同一项目直接子级下", async () => {
    const pid = await createProjectViaUi("任务项目B");
    expect(pid).toMatch(/^\d+$/);

    await fx.sh.getJson(`./diy.sh ui task create 首任务 ${pid}`);
    await fx.sh.getJson(`./diy.sh ui task create 次任务 ${pid}`);

    const titles = childTitles(pid, await treeData());
    expect(titles).toEqual(["首任务", "次任务"]);

    await cleanupProj(pid);
  });

  it("建子任务（--parent）→ 挂到父任务下而非项目直接子级", async () => {
    const pid = await createProjectViaUi("任务项目C");
    expect(pid).toMatch(/^\d+$/);
    const uri = `projects/${pid}/tasks/1`;

    // 建父任务 + 子任务
    await fx.sh.getJson(`./diy.sh ui task create 父任务 ${pid}`);
    const sub = await fx.sh.getJson(`./diy.sh ui task create 子任务 ${pid} --parent ${uri}`);

    // 验证任务出现在父任务 children 下，而非项目直接子级
    const nodes = await treeData();
    const proj = nodes.find((n) => n?.project === pid);
    const parentNode = proj?.children?.find((c: any) => c?.uri === uri);
    const subTitles = (parentNode?.children ?? []).map((c: any) => c?.title ?? "");
    expect(subTitles).toContain("子任务");
    // 项目直接子级只有父任务
    expect(childTitles(pid, nodes)).toEqual(["父任务"]);

    await cleanupProj(pid);
  });
});
