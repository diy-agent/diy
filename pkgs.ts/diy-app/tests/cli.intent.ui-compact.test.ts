// tests/cli.intent.ui-compact.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 压缩会话 UI 意图验证（真实 renderer + CDP 原生点击）
//
// 需求（##246）：token 窗口面板旁的「压缩」大按钮 → 打开压缩面板（保留 N 轮 + 工具输出选项
//   + 事实行）→「压缩」→ 当前会话只剩边界后的轮；旧历史仍在（历史会话面板可查）。
//
// 分工：三条核心契约（不删历史 / 投递自边界起 / 归档可查）在 cli.intent.agent-local.test.ts
//   用 CLI 断言；本文件只验证**界面真的可交互且结果上屏**（按钮点得动、面板出得来、压缩生效）。
//
// 隐私/隔离：与其它 ui intent 同套路，用隔离 Electron 的 HOME 直写 ops.jsonl（UI 重放的权威输入）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { basename, dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(electron.cdpUrl, async () => {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as any)?.data?.tree as A11yNode | undefined;
  });
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

async function a11yText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui inspect");
  const acc: string[] = [];
  const walk = (n: any) => {
    if (n?.text) acc.push(String(n.text));
    for (const c of n?.children ?? []) walk(c);
  };
  walk((res.data as any)?.data?.tree);
  return acc.join("\n");
}

/** 正文里的文本（判「某轮还在不在」） */
const bodyHas = (s: string) => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify(s)})`);

describe("压缩会话：面板 → 压缩 → 当前会话只剩边界后的轮", () => {
  it("setup: 造 8 轮会话（每轮一个可辨识的用户文本）", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/cp --label 压缩`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "压缩 UI 验证" ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);

    const file = join(fx.HOME, "local", basename(opsFile(uri)));
    mkdirSync(dirname(file), { recursive: true });
    const ops: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 8; i++) {
      const tn = `t${1000 + i}`;
      ops.push({ op: "start", id: tn, kind: "turn", meta: { model: "test" } });
      ops.push({ op: "start", id: `${tn}_u`, kind: "text", parent: tn, meta: { role: "user" } });
      ops.push({ op: "delta", id: `${tn}_u`, fields: { content: `第${i}轮问题` } });
      ops.push({ op: "stop", id: `${tn}_u` });
      ops.push({ op: "start", id: `${tn}_a`, kind: "text", parent: tn, meta: { role: "assistant" } });
      ops.push({ op: "delta", id: `${tn}_a`, fields: { content: `第${i}轮回复，结论如下。` } });
      ops.push({ op: "stop", id: `${tn}_a` });
      ops.push({ op: "start", id: `${tn}_r`, kind: "tool", parent: tn, meta: { tool: "bash" } });
      ops.push({ op: "patch", id: `${tn}_r`, fields: { args: { command: "rg -n x" }, status: "done", title: "rg -n x" } });
      ops.push({ op: "delta", id: `${tn}_r`, fields: { output: Array.from({ length: 30 }, (_, k) => `row ${k}`).join("\n") } });
      ops.push({ op: "stop", id: `${tn}_r` });
      ops.push({ op: "stop", id: tn });
    }
    writeFileSync(file, ops.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
  });

  it("打开任务页 → 「压缩」按钮在 token 窗口面板旁", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await waitUntil(a11yText, (t) => t.includes("第8轮问题"), { label: "会话历史渲染上屏" });
    // 按钮存在（DOM 层按 aria-label 定位 —— a11y 文本树给的是可见文字）
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩会话上下文"]')`)).toBe(true);
    expect(await a11yText()).toContain("压缩");
  });

  it("点「压缩」→ 面板出现（压缩选项 / 压缩后估算两个可折叠 view）", async () => {
    // 等按钮就位（页面可能还在挂载），再点 —— 避免与挂载竞争
    await waitUntil(
      () => ui.query<boolean>("!!document.querySelector('[aria-label=\"压缩会话上下文\"]')"),
      (v) => v === true,
      { label: "压缩按钮就位" },
    );
    await ui.clickSelector('[aria-label="压缩会话上下文"]');
    const text = await waitUntil(a11yText, (t) => t.includes("① 保留范围"), { label: "压缩面板上屏" });
    expect(text).toContain("② 工具输出");
    expect(text).toContain("③ 计算历史摘要");
    // 两个 view 用统一的折叠框模式（标题条可点）
    expect(text).toContain("压缩选项");
    expect(text).toContain("压缩后估算");
    // 默认保留 6 轮、共 8 轮（数字与「保留最近」在 a11y 树里是不同节点）
    expect(text).toContain("保留最近");
    expect(text).toContain("共 8 轮");
  });

  it("压缩后估算表列头（被压缩的历史消息/压缩前/压缩后/预估节省）+ 合计居首、各层带 ├/└ 层级符号", async () => {
    const text = await a11yText();
    for (const h of ["被压缩的历史消息", "压缩前", "压缩后", "预估节省"]) expect(text).toContain(h);
    const firstRow = await ui.query<string>(
      "(() => { const tr = document.querySelector('table tbody tr'); return tr ? [...tr.children].map(td => td.textContent.trim()).join('|') : ''; })()",
    );
    expect(firstRow.startsWith("合计|")).toBe(true);
    const hasBranch = await ui.query<boolean>(
      "!!document.querySelector('table tbody tr td') && document.querySelector('table tbody').textContent.includes('├')",
    );
    expect(hasBranch).toBe(true);
  });

  it("折叠节点标出内部变更（外层不必逐级展开即可见 ●-x/+y）", async () => {
    const dot = await waitUntil(
      () =>
        ui.query<string>(
          "document.querySelector('[data-compact-preview] [title*=\"内含变更\"]')?.textContent?.trim() ?? ''",
        ),
      (t) => t.includes("●"),
      { label: "折叠变更点出现" },
    );
    expect(dot).toContain("●");
  });

  it("逐级展开：按钮显示「展开 i/N」，点一下多展开一级（N 随 YAML 深度）", async () => {
    const label0 = await ui.query<string>(
      "document.querySelector('[aria-label=\"逐级展开\"]')?.textContent?.trim() ?? ''",
    );
    const m = /展开 (\d+)\/(\d+)/.exec(label0);
    expect(m).not.toBeNull();
    const cur = Number(m![1]);
    const n = Number(m![2]);
    expect(n).toBeGreaterThan(1);
    await ui.clickSelector('[aria-label="逐级展开"]');
    const label1 = await ui.query<string>(
      "document.querySelector('[aria-label=\"逐级展开\"]')?.textContent?.trim() ?? ''",
    );
    expect(label1).toBe(`展开 ${cur + 1 <= n ? cur + 1 : 0}/${n}`);
  });

  it("右栏渲染请求 YAML diff（含 system/messages 与增删行）", async () => {
    // YAML 结构（右栏）：base vs mod 的请求字段
    // 只看差异默认开 → 预览只显示变化行（丢掉的旧轮内容）
    const diffText = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("第1轮问题") && t.includes("第2轮问题"),
      { label: "diff 上屏" },
    );
    expect(diffText).toContain("第1轮问题"); // 被丢的旧轮出现在删除行
    expect(await ui.query<boolean>("!!document.querySelector('[data-compact-preview] [data-diff=\"del\"]')")).toBe(true);

    // 关掉「只看差异」→ 完整 YAML 结构可见（system / messages 等字段）
    await ui.click("只看差异");
    const yaml = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("system:") && t.includes("messages:"),
      { label: "完整 YAML 上屏" },
    );
    expect(yaml).toContain("system");
    expect(yaml).toContain("messages");
    await ui.click("只看差异"); // 复位
  });

  it("切「并排」视图不报错且两栏都在", async () => {
    await ui.click("并排");
    await new Promise((r) => setTimeout(r, 150));
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(true);
    await ui.click("统一 diff");
  });

  it("点「执行压缩」→ 当前会话不再含最早两轮（第1/2轮），较新一轮仍在", async () => {
    await ui.clickSelector('[aria-label="执行压缩"]');
    // 面板关闭
    await waitUntil(a11yText, (t) => !t.includes("① 保留范围"), { label: "压缩面板退场" });
    // 当前会话视图只剩边界后的轮
    expect(await waitUntil(() => bodyHas("第1轮问题"), (v) => v === false, { label: "第1轮消失" })).toBe(false);
    expect(await bodyHas("第2轮问题")).toBe(false);
    expect(await bodyHas("第8轮问题")).toBe(true);
  });

  it("旧历史仍可查：CLI generations 出两代，generationOps(0) 仍含第1轮", async () => {
    const gens = (await fx.sh.getJson(`./diy.sh agent local generations ${uri}`)).data as Array<{ seq: number; current: boolean }>;
    expect(gens).toHaveLength(2);
    expect(gens[1]).toMatchObject({ seq: 1, current: true });
    const old = (await fx.sh.getJson(`./diy.sh agent local generationOps ${uri} 0`)).data as unknown[];
    expect(JSON.stringify(old)).toContain("第1轮问题");
  });
});
