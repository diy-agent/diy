// tests/cli.intent.ui-compact.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 压缩会话 UI 意图验证（真实 renderer + CDP 原生点击）
//
// 需求（##246 → ##271 N6 → ##272 M1）：压缩并入「窗口构成页」——
//   · L2（hover token 窗口卡）= 只读 + **一键快捷压缩** + 「明细 ›」进详情页；
//   · L3（窗口构成抽屉）= **第一 tab 就是压缩**（预算区 + 参数 + 费用图 + 预览 diff），
//     tab 栏另有一个「压缩」执行按钮（同构能力，级别不同）。
//   「压缩（详情页）」→ 账本记一次预算压缩；历史**不销毁**（聊天页仍可见，历史可查）。
//
// 分工：核心契约（纵向优先级 / 不删历史 / 注记）在 tests/core/compaction-budget.test.ts 等
//   单测里断言；本文件只验证**界面真的可交互且结果上屏**。
//
// 隐私/隔离：与其它 ui intent 同套路，用隔离 Electron 的 HOME 直写 ops.jsonl（UI 重放的权威输入）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

const NL = String.fromCharCode(10);

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
  return acc.join(NL);
}

/** 把预览区展开档位设到最大（`展开 N/N`），保证后续断言看到完整 YAML */
async function expandAll(): Promise<void> {
  const re = new RegExp("展开 ([0-9]+)/([0-9]+)");
  for (let i = 0; i < 12; i++) {
    const label = await ui.query<string>(`document.querySelector('[aria-label="逐级展开"]')?.textContent?.trim() ?? ''`);
    const m = re.exec(label);
    if (!m) return;
    if (Number(m[1]) >= Number(m[2])) return;
    await ui.clickSelector('[aria-label="逐级展开"]');
  }
}

/** hover token 窗口环 → 弹出 L2 卡（含「压缩」快捷直压 + 「明细 ›」） */
async function hoverRing(): Promise<void> {
  await ui.query<string>(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('窗口占用')); if(!b) return 'no'; b.dispatchEvent(new Event('pointerenter')); return 'ok'; })()`,
  );
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('[aria-label="压缩会话上下文"]')`),
    (v) => v === true,
    { label: "压缩卡出现" },
  );
}

/** 点环 → 开 L3「窗口构成」抽屉（默认第一 tab = 压缩） */
async function openDrawer(): Promise<void> {
  await ui.clickSelector('button[aria-label^="窗口占用"]');
  await waitUntil(a11yText, (t) => t.includes("窗口构成"), { label: "窗口构成抽屉打开" });
}

/** 正文里的文本（判「某轮还在不在」） */
const bodyHas = (s: string) => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify(s)})`);

/** 预算输入框当前值（KB） */
const budgetKb = () => ui.query<string>(`document.querySelector('input[aria-label="压缩预算KB"]')?.value ?? ''`);

/** 在预算输入框里设 KB 并提交（input + change） */
async function setBudgetKb(kb: number): Promise<void> {
  await ui.query<string>(
    `(() => { const i=document.querySelector('input[aria-label="压缩预算KB"]'); if(!i) return 'x'; i.value=${JSON.stringify(String(kb))}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
  );
  await new Promise((r) => setTimeout(r, 500));
}

const autoYaml = () => readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8");
const compactLog = () =>
  readFileSync(join(fx.HOME, "local", basename(opsFile(uri)).replace(".ops.jsonl", ".compact.jsonl")), "utf-8");
const budgetMarks = () => (compactLog().match(/"mode":"budget"/g) || []).length;

describe("压缩会话：窗口卡快捷直压 + 窗口构成页第一 tab 压缩 → 历史不销毁", () => {
  it("setup: 造 8 轮会话（每轮一个可辨识的用户文本）", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/cp --label 压缩`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "压缩 UI 验证" ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    expect(uri).toMatch(new RegExp("^projects/.+/tasks/.+$"));

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
      ops.push({ op: "delta", id: `${tn}_r`, fields: { output: Array.from({ length: 30 }, (_, k) => `row ${k}`).join(NL) } });
      ops.push({ op: "stop", id: `${tn}_r` });
      ops.push({ op: "stop", id: tn });
    }
    writeFileSync(file, ops.map((o) => JSON.stringify(o)).join(NL) + NL, "utf-8");
  });

  it("hover token 窗口环 → L2 卡出现「压缩」（快捷直压）+「明细 ›」", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await waitUntil(a11yText, (t) => t.includes("第8轮问题"), { label: "会话历史渲染上屏" });
    expect(await ui.query<boolean>(`[...document.querySelectorAll('button')].some(b=>(b.getAttribute('aria-label')||'').startsWith('窗口占用'))`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩会话上下文"]')`)).toBe(false);
    await hoverRing();
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩会话上下文"]')`)).toBe(true);
  });

  it("点环 → 窗口构成抽屉：**第一 tab 是压缩**（自动压缩 + 压缩到 + 费用对比），tab 栏有「压缩」执行按钮", async () => {
    await openDrawer();
    const text = await waitUntil(a11yText, (t) => t.includes("压缩到"), { label: "压缩 tab 上屏" });
    expect(text).toContain("自动压缩");
    expect(text).toContain("压缩到");
    expect(text).toContain("费用对比");
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="自动压缩"]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩（详情页）"]')`)).toBe(true);
    expect(await ui.query<string>(`document.querySelector('[aria-label="窗口构成视图"] button')?.textContent?.trim() ?? ''`)).toBe("压缩");
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="窗口构成视图"] button.btn-active')`)).toBe(true);
    expect(await budgetKb()).toBe("3");
  });

  it("自动压缩：toggle 写回真源 $DIY_HOME/auto-compact.yaml（auto ⇄ off）", async () => {
    expect(await ui.query<boolean>(`document.querySelector('input[aria-label="自动压缩"]')?.checked`)).toBe(false);
    await ui.query<string>(`(() => { const t=document.querySelector('input[aria-label="自动压缩"]'); t.checked=true; t.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`);
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: auto"), { label: "toggle 开 → auto" });
    await ui.query<string>(`(() => { const t=document.querySelector('input[aria-label="自动压缩"]'); t.checked=false; t.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`);
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: off"), { label: "toggle 关 → off" });
  });

  it("压缩到输入：手改写回真源（3KB=3072，预算形状）", async () => {
    await setBudgetKb(3);
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("budgetBytes: 3072"), { label: "手改写回真源（3KB=3072）" });
    expect(autoYaml()).toContain("mode: budget");
  });

  it("费用对比（图形）：当前 / 压缩后两条 + 省 $x（−y%）", async () => {
    const text = await a11yText();
    expect(text).toContain("费用对比");
    expect(text).toContain("当前");
    expect(text).toContain("压缩后");
    const bars = await ui.query<number>(`document.querySelectorAll('[data-cost-bar]').length`);
    expect(bars).toBe(2);
    expect(await ui.query<string>(`document.querySelector('[data-cost-saved]')?.textContent?.trim() ?? ''`)).toMatch(new RegExp("省|无节省"));
  });

  it("预览区渲染请求 YAML diff（含 system/messages 与增删行）", async () => {
    await expandAll();
    await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("第1轮问题"),
      { label: "diff 上屏" },
    );
    expect(await ui.query<boolean>(`!!document.querySelector('[data-compact-preview] [data-diff="del"]')`)).toBe(true);

    await ui.click("只看差异");
    const yaml = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("system:") && t.includes("messages:"),
      { label: "完整 YAML 上屏" },
    );
    expect(yaml).toContain("system");
    expect(yaml).toContain("messages");
    await ui.click("只看差异");
  });

  it("逐级展开：按钮显示「展开 i/N」，点一下多展开一级", async () => {
    const re = new RegExp("展开 ([0-9]+)/([0-9]+)");
    const label0 = await ui.query<string>(`document.querySelector('[aria-label="逐级展开"]')?.textContent?.trim() ?? ''`);
    const m = re.exec(label0);
    expect(m).not.toBeNull();
    const cur = Number(m![1]);
    const n = Number(m![2]);
    expect(n).toBeGreaterThan(1);
    expect(cur).toBe(n);
    await ui.clickSelector('[aria-label="逐级展开"]');
    const label1 = await ui.query<string>(`document.querySelector('[aria-label="逐级展开"]')?.textContent?.trim() ?? ''`);
    expect(label1).toBe(`展开 ${cur + 1 <= n ? cur + 1 : 0}/${n}`);
    await expandAll();
  });

  it("切「总表（按轮）/ 分表（按步）」：压缩内容退场（无用量记录 → 空态），可切回", async () => {
    await ui.click("总表（按轮）");
    await waitUntil(a11yText, (t) => !t.includes("压缩到"), { label: "压缩 tab 退场" });
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(false);
    await ui.click("分表（按步）");
    await new Promise((r) => setTimeout(r, 150));
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(false);
    await ui.clickSelector('[aria-label="窗口构成视图"] button');
    await waitUntil(a11yText, (t) => t.includes("压缩到"), { label: "压缩 tab 回归" });
  });

  it("点「压缩（详情页）」→ 账本记预算压缩；**历史不销毁**（聊天页仍可见第1轮）", async () => {
    await ui.clickSelector('[aria-label="压缩（详情页）"]');
    await waitUntil(() => Promise.resolve(compactLog()), (t) => t.includes('"mode":"budget"'), { label: "账本记 budget 压缩" });
    expect(await waitUntil(() => bodyHas("第1轮问题"), (v) => v === true, { label: "第1轮仍在（不销毁）" })).toBe(true);
    expect(await bodyHas("第8轮问题")).toBe(true);
  });

  it("历史未销毁：ops 原文仍含全部 8 轮；压缩事件账有快照（算法 + 过滤器）", async () => {
    const opsRaw = readFileSync(join(fx.HOME, "local", basename(opsFile(uri))), "utf-8");
    for (let i = 1; i <= 8; i++) expect(opsRaw).toContain(`第${i}轮问题`);
    const events = (await fx.sh.getJson(`./diy.sh agent local compactEvents ${uri}`)).data as Array<{ kind: string; policy?: { mode?: string } }>;
    const compacts = events.filter((e) => e.kind === "compact");
    expect(compacts.length).toBeGreaterThanOrEqual(1);
    expect(compacts[0]!.policy?.mode).toBe("budget");
  });

  it("卡内快捷直压：关抽屉 → hover 环 → 点「压缩会话上下文」→ 账本再记一条 budget", async () => {
    await ui.clickSelector('[aria-label="关闭窗口构成"]');
    await new Promise((r) => setTimeout(r, 150));
    const before = budgetMarks();
    await hoverRing();
    await ui.clickSelector('[aria-label="压缩会话上下文"]');
    await waitUntil(() => Promise.resolve(budgetMarks()), (n) => n > before, { label: "快捷直压再记一条" });
  });
});
