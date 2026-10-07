// tests/cli.intent.ui-compact.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 压缩会话 UI 意图验证（真实 renderer + CDP 原生点击）
//
// 需求（##246 → ##271 N6）：token 窗口面板旁的「压缩」大按钮 → 打开压缩面板
//   （**目标式预算**：一个 `压缩到 ___ KB` 输入 + 预设清零/不压缩 + 立即压缩）→
//   「立即压缩」→ 账本记一次预算压缩；历史**不销毁**（聊天页仍可见，历史会话可查）。
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

/** 把右栏展开档位设到最大（`展开 N/N`），保证后续断言看到完整 YAML */
async function expandAll(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const label = await ui.query<string>(
      "document.querySelector('[aria-label=\"逐级展开\"]')?.textContent?.trim() ?? ''",
    );
    const m = /展开 (\d+)\/(\d+)/.exec(label);
    if (!m) return;
    if (Number(m[1]) >= Number(m[2])) return;
    await ui.clickSelector('[aria-label="逐级展开"]');
  }
}

/** 正文里的文本（判「某轮还在不在」） */
const bodyHas = (s: string) => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify(s)})`);

/** 预算输入框当前值（KB） */
const budgetKb = () =>
  ui.query<string>(`document.querySelector('input[aria-label="压缩预算KB"]')?.value ?? ''`);

/** 在预算输入框里设 KB 并提交（input + change） */
async function setBudgetKb(kb: number): Promise<void> {
  await ui.query<string>(
    `(() => { const i=document.querySelector('input[aria-label="压缩预算KB"]'); if(!i) return 'x'; i.value=${JSON.stringify(String(kb))}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
  );
  await new Promise((r) => setTimeout(r, 500));
}

describe("压缩会话：面板 → 立即压缩 → 历史不销毁", () => {
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
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩会话上下文"]')`)).toBe(true);
    expect(await a11yText()).toContain("压缩");
  });

  it("点「压缩」→ 面板出现：一个预算输入 + 预设 + 立即压缩（无决策树）", async () => {
    await waitUntil(
      () => ui.query<boolean>("!!document.querySelector('[aria-label=\"压缩会话上下文\"]')"),
      (v) => v === true,
      { label: "压缩按钮就位" },
    );
    await ui.clickSelector('[aria-label="压缩会话上下文"]');
    const text = await waitUntil(a11yText, (t) => t.includes("压缩预算"), { label: "压缩面板上屏" });
    // 预算 UI
    expect(text).toContain("压缩到");
    expect(text).toContain("清零");
    expect(text).toContain("不压缩");
    expect(text).toContain("何时自动压");
    expect(text).toContain("触发条件与状态");
    expect(text).toContain("立即压缩");
    expect(text).toContain("压缩后估算");
    // 旧决策树 UI **不再出现**
    expect(text).not.toContain("1. 这次怎么压");
    expect(text).not.toContain("2. 保留范围");
    expect(text).not.toContain("② 本次手动压缩");
    // 预算输入默认 3KB（用户定的经验值）
    expect(await budgetKb()).toBe("3");
  });

  it("预设「清零」→ 0 KB；「不压缩」→ 大值；手改写回真源 $DIY_HOME/auto-compact.yaml", async () => {
    // 清零
    await ui.clickSelector('[aria-label="预设清零"]');
    await waitUntil(budgetKb, (v) => v === "0", { label: "清零 → 0" });
    await waitUntil(
      () => Promise.resolve(readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8")),
      (t) => t.includes("budgetBytes: 0"),
      { label: "清零写回真源" },
    );
    // 不压缩（大值）
    await ui.clickSelector('[aria-label="预设不压缩"]');
    await waitUntil(budgetKb, (v) => Number(v) > 1000, { label: "不压缩 → 大值" });
    // 手改 3 KB
    await setBudgetKb(3);
    await waitUntil(
      () => Promise.resolve(readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8")),
      (t) => t.includes("budgetBytes: 3072"),
      { label: "手改写回真源（3KB=3072）" },
    );
    const yaml = readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8");
    expect(yaml).toContain("mode: budget"); // 真源是预算形状（非决策树）
  });

  it("自动压缩：模式开关可选，且模式真源落盘（非 localStorage）", async () => {
    const sel = await ui.query<string>(
      `(() => { const s=document.querySelector('select[aria-label="自动压缩模式"]'); return s ? s.value : ''; })()`,
    );
    expect(sel).toBe("notify");
    await ui.query<string>(
      `(() => { const s=document.querySelector('select[aria-label="自动压缩模式"]'); if(!s) return ''; s.value='auto'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(await ui.query<string>(`document.querySelector('select[aria-label="自动压缩模式"]')?.value ?? ''`)).toBe("auto");
    await ui.query<string>(
      `(() => { const s=document.querySelector('select[aria-label="自动压缩模式"]'); if(!s) return ''; s.value='notify'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
  });

  it("触发条件区：默认收起；展开后可改触发条件，改完写回真源", async () => {
    expect(await a11yText()).not.toContain("系统上下文变化");
    await ui.clickSelector('[aria-label="自动压缩配置开关"]');
    const text = await waitUntil(a11yText, (t) => t.includes("触发条件"), { label: "触发条件区展开" });
    expect(text).toContain("系统上下文变化");
    expect(text).toContain("缓存过期");
    expect(text).toContain("窗口占用超过");
    expect(text).toContain("距上次请求");
    expect(text).toContain("窗口占用");

    const before = readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8");
    expect(before).toContain("cacheExpired: true");
    await ui.clickSelector('[aria-label="触发：缓存过期"]');
    await waitUntil(
      () => Promise.resolve(readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8")),
      (t) => String(t).includes("cacheExpired: false"),
      { label: "触发开关写回真源" },
    );
    await ui.clickSelector('[aria-label="触发：缓存过期"]');
    await waitUntil(
      () => Promise.resolve(readFileSync(join(fx.HOME, "auto-compact.yaml"), "utf-8")),
      (t) => String(t).includes("cacheExpired: true"),
      { label: "触发开关复原" },
    );
    await ui.clickSelector('[aria-label="自动压缩配置开关"]');
    await waitUntil(a11yText, (t) => !t.includes("系统上下文变化"), { label: "配置区收起" });
  });

  it("压缩后估算表：中文层名 + 合计居首 + ├/└ 层级符号", async () => {
    const text = await a11yText();
    for (const h of ["被压缩的历史消息", "压缩前", "压缩后", "预估节省"]) expect(text).toContain(h);
    for (const name of ["系统提示词", "工具定义", "用户消息", "模型回复", "工具调用", "工具结果"]) {
      expect(text).toContain(name);
    }
    const firstRow = await ui.query<string>(
      "(() => { const tr = document.querySelector('table tbody tr'); return tr ? [...tr.children].map(td => td.textContent.trim()).join('|') : ''; })()",
    );
    expect(firstRow.startsWith("合计|")).toBe(true);
    const hasBranch = await ui.query<boolean>(
      "!!document.querySelector('table tbody tr td') && document.querySelector('table tbody').textContent.includes('├')",
    );
    expect(hasBranch).toBe(true);
  });

  it("右栏渲染请求 YAML diff（含 system/messages 与增删行）", async () => {
    await expandAll();
    const diffText = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("第1轮问题"),
      { label: "diff 上屏" },
    );
    expect(await ui.query<boolean>("!!document.querySelector('[data-compact-preview] [data-diff=\"del\"]')")).toBe(true);

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
    const label0 = await ui.query<string>(
      "document.querySelector('[aria-label=\"逐级展开\"]')?.textContent?.trim() ?? ''",
    );
    const m = /展开 (\d+)\/(\d+)/.exec(label0);
    expect(m).not.toBeNull();
    const cur = Number(m![1]);
    const n = Number(m![2]);
    expect(n).toBeGreaterThan(1);
    expect(cur).toBe(n);
    await ui.clickSelector('[aria-label="逐级展开"]');
    const label1 = await ui.query<string>(
      "document.querySelector('[aria-label=\"逐级展开\"]')?.textContent?.trim() ?? ''",
    );
    expect(label1).toBe(`展开 ${cur + 1 <= n ? cur + 1 : 0}/${n}`);
    await expandAll();
  });

  it("压缩抽屉可在「默认尺寸 ⇄ 最大化」间切换（底部拖拽把手的抽屉）", async () => {
    const scope = `document.querySelector('[data-compact-preview]')?.closest('[style*="height"]')`;
    const btn = (v: "0" | "1") => `document.querySelector('[data-compact-preview]')?.closest('[style*="height"]')?.querySelector('[data-drawer-max="${v}"]')`;
    const h = () => ui.query<number>(`${scope}?.getBoundingClientRect().height ?? 0`);
    const h0 = await h();
    expect(h0).toBeGreaterThan(0);
    expect(await ui.query<boolean>(`!!${btn("0")}`)).toBe(true);
    await ui.query<string>(`${btn("0")}?.click(); 'x'`);
    await new Promise((r) => setTimeout(r, 200));
    const h1 = await h();
    const vh = await ui.query<number>("window.innerHeight");
    expect(h1).toBeGreaterThan(h0);
    expect(Math.abs(h1 - vh)).toBeLessThanOrEqual(2);
    expect(await ui.query<boolean>(`!!${btn("1")}`)).toBe(true);
    await ui.query<string>(`${btn("1")}?.click(); 'x'`);
    await new Promise((r) => setTimeout(r, 200));
    expect(Math.abs((await h()) - h0)).toBeLessThanOrEqual(2);
  });

  it("切「并排」视图不报错且两栏都在", async () => {
    await ui.click("并排");
    await new Promise((r) => setTimeout(r, 150));
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(true);
    await ui.click("统一 diff");
  });

  it("点「立即压缩」→ 面板退场；账本记预算压缩；**历史不销毁**（聊天页仍可见第1轮）", async () => {
    await ui.clickSelector('[aria-label="立即压缩"]');
    await waitUntil(a11yText, (t) => !t.includes("压缩预算"), { label: "压缩面板退场" });
    // 账本新增一条 mode:budget 的 compact
    const log = readFileSync(join(fx.HOME, "local", basename(opsFile(uri)).replace(/\.ops\.jsonl$/, ".compact.jsonl")), "utf-8");
    expect(log).toContain('"mode":"budget"');
    // 历史不销毁：聊天页仍看得到最早那轮（少发 ≠ 销毁）
    expect(await waitUntil(() => bodyHas("第1轮问题"), (v) => v === true, { label: "第1轮仍在（不销毁）" })).toBe(true);
    expect(await bodyHas("第8轮问题")).toBe(true);
  });

  it("旧历史未销毁：ops 原文仍含全部 8 轮；generations 列表非空", async () => {
    // 预算选择是**分散**的（用户发言作为主干即使最早也优先保留），故「代」的连续轮边界
    // 可能落在第 1 轮 → 第 0 代为空 —— 这是预算模型的正常形态，不是 bug。真正的保证是
    // **原文一字不删**（少发 ≠ 销毁）：
    const opsRaw = readFileSync(join(fx.HOME, "local", basename(opsFile(uri))), "utf-8");
    for (let i = 1; i <= 8; i++) expect(opsRaw).toContain(`第${i}轮问题`);
    const gens = (await fx.sh.getJson(`./diy.sh agent local generations ${uri}`)).data as Array<{ seq: number; current: boolean }>;
    expect(gens.length).toBeGreaterThanOrEqual(1);
  });
});
