// tests/cli.intent.ui-lab.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 试验场两个 view 的**渲染**验证（不是 RPC 契约验证）
//
// AGENTS.md 的教训：CLI 的 RPC 返回成功 ≠ renderer 渲染正确。这里走
//   ui page navigate lab → ui page focus <任务> → 读 a11y 树
// 确认「可用变量」与「结构树」两块真的上了屏，且内容来自引擎的 analyze/trace。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };

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

/** a11y 树文本（ui inspect 才是 DOM 树；ui tree 是任务树，别混） */
function collectText(nodes: any[], acc: string[] = []): string[] {
  for (const n of nodes ?? []) {
    if (n?.text) acc.push(String(n.text));
    if (n?.children) collectText(n.children, acc);
  }
  return acc;
}

async function a11yText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui inspect");
  return collectText([(res.data as any)?.data?.tree]).join("\n");
}

describe("试验场：可用变量 / 结构树 两个 view", () => {
  it("导航到试验场 → 两块 view 上屏，且内容来自 analyze/trace", async () => {
    // 1. 造一个项目 + 任务（试验场以选中任务为场景）
    const repo = `${fx.HOME}/lab`;
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 试验场`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 试验场任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    // 2. 进试验场并选中任务（= 点左侧导航 + 点任务行）
    await fx.sh.getJson("./diy.sh ui page navigate lab");
    await fx.sh.getJson(`./diy.sh ui page focus ${uri}`);

    // 3. 读 a11y 树：两个 view 的标题 + 引擎分析出的内容
    const text = await waitUntil(
      a11yText,
      (s) => s.includes("可用变量") && s.includes("结构树"),
      { label: "试验场两块 view 上屏" },
    );
    expect(text).toContain("可用变量");
    expect(text).toContain("结构树");
    // 可用变量 view：宿主变量契约（类型 + 说明）与"本模版引用"都上屏
    expect(text).toContain("宿主提供（契约");
    expect(text).toContain("cwd.isFallback · boolean");
    expect(text).toContain("引用 globals");
    // 结构树 view：顶层是各节的 include（trace 的 name 就是 relpath）
    await fx.sh.getJson(`./diy.sh template preview ${pid} --taskUri ${uri}`);
    expect(await waitUntil(a11yText, (s) => s.includes("identity.md"))).toContain("identity.md");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 120_000);
});
