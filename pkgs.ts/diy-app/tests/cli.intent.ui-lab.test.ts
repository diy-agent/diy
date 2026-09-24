// tests/cli.intent.ui-lab.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 试验场两个 view 的**渲染**验证（不是 RPC 契约验证）
//
// AGENTS.md 的教训：CLI 的 RPC 返回成功 ≠ renderer 渲染正确。这里走
//   ui tab open <任务> → ui tab open lab:<任务> → 读 a11y 树
// 确认「变量定义 / 变量值 / 模版结构树」三块真的上了屏，且内容来自引擎的 analyze/trace。
//
// 契约变更（见 133「一页一中心」）：提示词页是**子页面**（中心 = 系统提示词），
// 挂在某个任务的任务执行 tab 之下，不进顶级导航。故导航路径从
// `ui page navigate lab` 改为「打开任务 tab → 打开其子页面 tab」。
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

describe("试验场：变量定义 / 变量值 / 模版结构树 三个 view + 高亮导航条", () => {
  it("导航到试验场 → 四块 view 上屏，内容来自 analyze/trace", async () => {
    // 1. 造一个项目 + 任务（试验场以选中任务为场景）
    const repo = `${fx.HOME}/lab`;
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 试验场`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 试验场任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    // 2. 打开任务执行页（= 任务详情里点大 FAB）→ 再打开它的子页面（提示词页）
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open lab:${uri}`);

    // 3. 展开要看的折叠框（默认只展开「模板」）。注意这是 view **内部**的展开态，
    //    与上一步「viewarea 开合」是两件事（见 ui view expand / ui viewarea set 的区分）
    for (const key of ["trace", "vars", "vals"]) {
      await fx.sh.getJson(`./diy.sh ui view expand ${key} open`);
    }
    // 4. 读 a11y 树：四个 view 的标题 + 引擎分析出的内容
    //    （debug UI 主交互 = 手动刷新：按需重算，不订阅外部事件流）
    expect((await waitUntil(a11yText, (s) => s.includes("⟳ 刷新")))).toContain("⟳ 刷新");
    const text = await waitUntil(
      a11yText,
      (s) => s.includes("变量定义") && s.includes("变量值") && s.includes("模版结构树"),
      { label: "试验场四块 view 上屏" },
    );
    expect(text).toContain("变量定义"); // 原名「变量定义」
    expect(text).toContain("变量值");
    expect(text).toContain("模版结构树");
    // 动态菜单条：**无选中时不渲染**（避免取消选中后留一条空横条）
    expect(text).not.toContain("0/0");
    // 子页面：菜单条上是本 page 的 area 开合按钮（中心 = 编辑器）
    expect(text).toContain("② center");
    // 左栏顺序：模板 → 模版结构树 → 变量定义 → 变量值
    const order = ["模板", "模版结构树", "变量定义", "变量值"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 变量定义 view：变量契约是**树形展开的 2 列表格**（变量 | 说明）
    expect(text).toContain("宿主提供（变量契约，树形展开）");
    expect(text).toContain("变量");
    expect(text).toContain("说明");
    // diy.cli 是 2 个节点（diy → cli），类型徽标上屏
    expect(text).toContain("diy");
    expect(text).toContain("cli");
    expect(text).toContain("string");
    // 数组展开为元素类型节点：chain → [ChainEntry] → path/scope/content；skills → [Skill]
    expect(text).toContain("[ChainEntry]");
    expect(text).toContain("[Skill]");
    // 说明列有内容（zod .describe()）
    expect(text).toContain("CLI 入口");
    expect(text).toContain("引用 globals");
    // 变量值 view：实际注入值（值随任务变化；结构和契约一致，数组按元素展开）
    await fx.sh.getJson(`./diy.sh template preview ${pid} --taskUri ${uri}`);
    const withValues = await waitUntil(a11yText, (s) => s.includes("变量值") && s.includes("本次注入的实际值"));
    expect(withValues).toContain("空数组"); // 未接入 skills → 一眼看出这次没数据
    expect(withValues).toContain(uri); // 任务 URI 是实际值
    // 模版结构树 view（4 列：节点 | 参数 | 值 | 字节）：参数与值分列展示
    expect(withValues).toContain("参数");
    expect(withValues).toContain("节点");
    expect(withValues).toContain(":for"); // 循环节点
    expect(withValues).toContain("chain :as=\"f\""); // 参数 = 模版里写的
    expect(withValues).toContain("数组"); // 值 = 求值结果
    expect(withValues).toContain("./identity.md"); // include 的参数是 relpath

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 120_000);
});
