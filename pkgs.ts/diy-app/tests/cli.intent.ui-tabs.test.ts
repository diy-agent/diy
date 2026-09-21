// tests/cli.intent.ui-tabs.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 任务 tab（动态页面）的**行为**契约 —— 走真实 renderer
//
// 语义（见 133）：打开 = 「我现在要做这个任务」，关闭 = 「暂时不理会」，
// **与任务状态无关**。等同浏览器/编辑器开 tab。
// 另含 137 的回归：非法 page 不得把主区打成白屏。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let uri = "";

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

/** 已打开的 tab */
async function tabs(): Promise<{ opened: string[]; active: string }> {
  const r = await fx.sh.getJson("./diy.sh ui tab list");
  return (r.data as any)?.data ?? { opened: [], active: "" };
}

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

describe("任务 tab —— 打开 / 聚焦 / 关闭", () => {
  it("setup: 造任务", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/tabs --label Tabs`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 任务tab验证 ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);
  });

  it("初始没有打开的 tab（回任务树）", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    expect((await tabs()).active).toBe("");
  });

  it("打开 → 出现在列表且成为 active；任务执行页真的上屏", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    expect(await waitUntil(
      async () => JSON.stringify(await tabs()),
      (s) => s.includes(uri),
      { label: "tab 出现在列表" },
    )).toContain(uri);
    expect((await tabs()).active).toBe(uri);

    // 渲染验证：执行页有 page 菜单条（每个 area 一个布局按钮）+ 左栏任务详情 + 中栏输入框
    const text = await waitUntil(a11yText, (s) => s.includes("任务详情") && s.includes("① left"), {
      label: "任务执行页上屏",
    });
    // 布局按钮：**本 page 有几个 area 就有几个**（不是只给试验场一个）
    expect(text).toContain("① left");
    expect(text).toContain("② center");
    expect(text).toContain("③ right");
    expect(text).toContain("④ bottom");
    expect(text).toContain("任务详情");
    expect(text).toContain("发送"); // chat 在
    // 详情不再有 tab（会话已移到 chat area）
    expect(text).not.toContain("🧪 Local");
  });

  it("重复打开同一任务 → 聚焦已有，不新开", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const t = await tabs();
    expect(t.opened).toEqual([uri]);
  });

  it("关闭 → 从列表移除并回到任务树（此时无 tab 可选）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab close ${uri}`);
    const t = await tabs();
    expect(t.opened).toEqual([]);
    expect(t.active).toBe("");
  });
});

describe("侧栏：高亮唯一 + 收缩/展开结构一致", () => {
  it("任务执行页时「任务管理」不高亮（高亮只落在具体 tab 上）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const text = await waitUntil(a11yText, (s) => s.includes("任务详情"), { label: "执行页就位" });
    // 侧栏项都在（且没有重复的「任务树」行 —— 它曾被冗余地塞在「任务」下面）
    expect(text).toContain("任务管理");
    expect(text).toContain("LLM");
    expect(text).toContain("设置");
  });
});

describe("非法 page 不得白屏（回归 137）", () => {
  it("navigate 到不存在的 page → 主区内容不变", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    const before = await waitUntil(a11yText, (s) => s.includes("创建项目"), { label: "任务树就位" });
    // "chat" 曾在 NavPage 字面量里但无对应视图分支 → 整页空白
    await fx.sh.getJson("./diy.sh ui page navigate chat");
    await fx.sh.getJson("./diy.sh ui page navigate 不存在的页面");
    const after = await a11yText();
    expect(after).toContain("创建项目"); // 仍在任务树，未被清空
    expect(collectText([null]).length).toBe(0);
    // 主区节点数不得塌成 0（侧面印证：导航项之外的文本仍在）
    expect(before.includes("创建项目")).toBe(true);
  });
});

describe("viewarea 开合（试验场面板）", () => {
  it("打开任务 tab 后展开 bottom → 试验场内容上屏；收起 → 消失", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    // 先确认默认收起（bottom 属开发者默认隐藏的 area）
    const before = await a11yText();
    expect(before).not.toContain("变量定义");
    await fx.sh.getJson("./diy.sh ui viewarea set bottom open");
    const open = await waitUntil(a11yText, (s) => s.includes("变量定义") && s.includes("模版结构树"), {
      label: "试验场内容上屏",
    });
    expect(open).toContain("系统提示词");

    await fx.sh.getJson("./diy.sh ui viewarea set bottom closed");
    const closed = await waitUntil(a11yText, (s) => !s.includes("变量定义"), {
      label: "试验场收起",
    });
    expect(closed).toContain("任务详情"); // 执行页本身还在
  });
});
