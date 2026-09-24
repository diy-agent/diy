// tests/cli.intent.ui-context.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 上下文树试验场（任务 148）的 RPC 契约 + **渲染**验证。
//
// 为什么要有渲染验证：CLI 的 RPC 返回成功 ≠ renderer 渲染正确（AGENTS.md 的教训）。
// 这里走「打开任务 → 打开上下文树 tab → 读 a11y 树」真实路径，确认六个块真的上屏。
//
// 页面定位：**独立子页面**（与提示词页 lab 平级挂在 task-run 下），
// 好处是与既有 view 互不干扰、且"示范数据"不会被误当成当前任务的真实上下文。
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

/** 展开/折叠试验场的某个块（key 带 ctx. 前缀，与提示词页的块分开命名空间） */
async function fold(key: string, open: boolean): Promise<void> {
  const res = await fx.sh.getJson(`./diy.sh ui view expand ctx.${key} ${open ? "open" : "closed"}`);
  expect((res.data as any)?.status, `折叠 ${key} 失败: ${JSON.stringify(res.data)}`).toBe("ok");
}

describe("上下文树试验场：RPC 契约", () => {
  it("diy context scenarios / lab 返回树 + 划分规则 + 两份投递 + 合成消息", async () => {
    // CLI stdout = RPC 的 output 本体（context 域直接返回数据，无 {status,data} 外壳）
    const list = await fx.sh.getJson("./diy.sh context scenarios");
    const names = (list.data as unknown as any[]).map((s: any) => s.name);
    expect(names).toEqual(["task"]);

    const res = await fx.sh.getJson("./diy.sh context lab");
    const d = res.data as any;

    // ① 必须自报家门是示范数据（否则会被误当成当前任务的真实上下文）
    expect(d.note).toContain("示范数据");
    expect(d.wireVersion).toMatch(/^[0-9a-f]{8}$/);

    // ② 变量树：一棵树，含身份与易变两类变量
    const paths = d.tree.map((n: any) => n.path);
    expect(paths).toContain("diy.cli");
    expect(paths).toContain("tasks.140.status");
    expect(d.tree.every((n: any) => typeof n.valueHash === "string")).toBe(true);

    // ③ ★核心：划分规则表 —— 每个单元都有归属 + 理由
    const ruleMap = Object.fromEntries(d.rules.map((r: any) => [r.place, r]));
    expect(ruleMap["diy"].container).toBe("system");
    expect(ruleMap["tasks"].container).toBe("runtime");
    expect(ruleMap["diy"].reason.length).toBeGreaterThan(4);
    expect(ruleMap["tasks"].renders).toContain("tasks.140.status");

    // ④ 两份投递各自有内容，且 system 里没有 runtime 的变量（划分真的生效）
    expect(d.system.text).toContain("diy.cli");
    expect(d.system.text).not.toContain("tasks.140.status");
    expect(d.runtime.text).toContain("tasks.140.status");
    expect(d.runtime.text).not.toContain("diy.cli");

    // ⑤ 合成消息：system 进 messages[0]，runtime 进 messages[1] 的 user
    expect(d.message.system).toBe(d.system.text);
    expect(d.message.user).toContain(d.runtime.text);
  }, 60_000);
});

describe("上下文树试验场：UI 上屏（独立子页面 + 折叠堆叠）", () => {
  it("打开任务 → 打开上下文树 tab → 六个块上屏，与提示词页互不干扰", async () => {
    const repo = `${fx.HOME}/ctxlab`;
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 上下文试验场`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上下文试验场任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    // 1. 打开任务执行页 → 打开其子页面（上下文树），**不打开**提示词页
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);

    // 2. 默认展开态：变量树 / 划分规则 / 两份都有内容，合成消息默认折叠
    const base = await waitUntil(
      a11yText,
      (s) => s.includes("变量树") && s.includes("划分规则") && s.includes("system 份"),
      { label: "试验场块上屏" },
    );
    expect(base).toContain("示范数据"); // 页头声明
    expect(base).toContain("runtime 份");
    expect(base).toContain("合成消息"); // header 在（折叠态）
    expect(base).toContain("diy.cli");
    expect(base).toContain("tasks.140.status");
    // 划分规则里的「为什么」（人话，不是术语）
    expect(base).toContain("进程身份");
    expect(base).toContain("最典型的易变项");
    expect(base).not.toContain("messages[1].user"); // 合成消息默认折叠

    // 3. 提示词页的块**没有**被带过来（互不干扰：这是另一个 page）
    expect(base).not.toContain("请求预览");

    // 4. 展开「合成消息」→ 两份合成后的消息形态上屏
    await fold("message", true);
    const msg = await waitUntil(a11yText, (s) => s.includes("messages[1].user"), {
      label: "合成消息上屏",
    });
    expect(msg).toContain("messages[0].system");
    expect(msg).toContain("Current runtime context:");

    // 5. 折回 → 内容消失，header 还在（可再展开）
    await fold("message", false);
    const folded = await waitUntil(a11yText, (s) => !s.includes("messages[1].user"), {
      label: "合成消息折叠",
    });
    expect(folded).toContain("合成消息");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 180_000);
});
