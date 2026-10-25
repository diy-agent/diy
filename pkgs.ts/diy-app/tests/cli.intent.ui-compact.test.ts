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

/** 会话文件的绝对路径（跨进程：产品在实例 home，本进程 home 是另一个）+ 建父目录 */
function seedFile(uri: string, kind: "ops" | "llm" | "compact" | "usage" | "steps" | "changelog" | "raw"): string {
    const fp = join(fx.HOME, sessionFileRel(uri, kind));
    mkdirSync(dirname(fp), { recursive: true });
    return fp;
}
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { compactFile } from "../src/main/services/local-agent";
import { opsFile } from "../src/main/core/local-paths";
import { keyOf, sessionFileRel } from "../src/main/core/local-paths";

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

/**
 * ##423 块 3：配置控件从 select/checkbox 换成了 daisyUI `filter`（radio 组）。
 * 组容器带 `data-*` 钩子；点选 = 真实 click 对应 `input[data-filter-value=…]`（同组互斥交给 browser）。
 */
async function pickFilter(group: string, value: string): Promise<string> {
  return ui.query<string>(
    `(() => { const g=document.querySelector(${JSON.stringify(group)}); if(!g) return 'no-group';
      const r=g.querySelector('input[data-filter-value=' + JSON.stringify(${JSON.stringify(value)}) + ']');
      if(!r) return 'no-option'; r.click(); return 'ok'; })()`,
  );
}

/** 某个 filter 组当前选中的值（radio 组没有 `.value`） */
async function pickedFilter(group: string): Promise<string> {
  return ui.query<string>(
    `(() => { const g=document.querySelector(${JSON.stringify(group)}); if(!g) return 'no-group';
      const r=g.querySelector('input[type=radio]:checked'); return r ? r.getAttribute('data-filter-value') : ''; })()`,
  );
}

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

/** 打开预览区的 diff 计算（##406 起差异视图缺省关闭，见 `CompactSessionPanel.tsx:915` / `:1396`） */
async function enableDiffPreview(): Promise<void> {
  const r = await ui.query<string>(
    `(() => { if (document.querySelector('[data-compact-preview]')) return 'already';
      const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('计算并显示 diff'));
      if(!b) return 'no-button'; b.click(); return 'ok'; })()`,
  );
  if (r === "no-button") {
    throw new Error("预览区没有「计算并显示 diff」按钮：差异视图的闸门形状变了（见 CompactSessionPanel.tsx 的 diffEnabled）");
  }
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('[data-compact-preview]')`),
    (v) => v === true,
    { label: "diff 面板打开" },
  );
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
/**
 * 打开「窗口构成」抽屉。
 * ⚠️ 必须用**合成 click**（`el.click()`）而非真实鼠标：环的 pointerenter 会弹出 hover 卡
 * （z-70），它正盖在抽屉 tab 上 —— 真实点击会落到卡上、且被遮的 tab 不进 a11y 树。
 * 合成 click 不产生 hover 链，绕开这层干扰（这里只验抽屉内逻辑，不验环的 hover 行为）。
 */
async function openDrawer(): Promise<void> {
  await ui.query<string>(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('窗口占用')); if(!b) return 'no'; b.click(); return 'ok'; })()`,
  );
  await waitUntil(a11yText, (t) => t.includes("窗口构成"), { label: "窗口构成抽屉打开" });
  await new Promise((r) => setTimeout(r, 120));
}

/** 正文里的文本（判「某轮还在不在」） */
const bodyHas = (s: string) => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify(s)})`);

/**
 * 滚到聊天区顶部，直到 `match` 出现在 DOM 里（上限 `max` 次，防死循环）。
 *
 * 为什么需要：聊天块树是**视口虚拟化**的（##301）—— DOM 里只挂视口附近若干轮，
 * 页面死在底部时第 1 轮根本不挂着，`document.body.textContent` 里也没有它。
 * 「更早的历史还在」的可观测判据 = 滚到顶就能看见（滚动容器见 `LocalChatPage.tsx:4218` 的 `.diy-chat`）。
 */
async function scrollChatToTopUntil(match: string, max = 10): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (await bodyHas(match)) return true;
    await ui.query<string>(`(() => {
      const el = document.querySelector('.diy-chat');
      if (!el) return 'no-scroller';
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return await bodyHas(match);
}

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
  readFileSync(join(fx.HOME, sessionFileRel(uri, "compact")), "utf-8");
const budgetMarks = () => (compactLog().match(/"mode":"budget"/g) || []).length;

describe("压缩会话：窗口卡快捷直压 + 窗口构成页第一 tab 压缩 → 历史不销毁", () => {
  // 造会话数据 = **夹具**，不是用例（##433）：写成 `it` 时它还兼着「给后面的用例置 `uri`」的职责，
  // 于是 `vitest run -t '历史未销毁'` 这类过滤只挑中后面那条时，`uri` 仍是初始的 `""` ——
  // 读侧拿空 uri 拼出 `local/-e3b0c44298fc/ops.jsonl`（空串 sha256 前 12 位）而 ENOENT。
  // 夹具必须在 describe 级 hook 里跑，与「跑哪几条用例」无关。
  beforeAll(async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/cp --label 压缩`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "压缩 UI 验证" ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    expect(uri).toMatch(new RegExp("^projects/.+/tasks/.+$"));

    const file = join(fx.HOME, sessionFileRel(uri, "ops"));
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

  it("点环 → 窗口构成抽屉：**第一 tab 是压缩**（自动压缩 + 参数区 + 费用对比），tab 栏有「压缩」执行按钮", async () => {
    await openDrawer();
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`),
      (v) => v === true,
      { label: "压缩 tab 上屏" },
    );
    const text = await a11yText();
    expect(text).toContain("自动压缩");
    expect(text).toContain("费用对比");
    // ##423 块 3：三态改 filter 组（旧 toggle 把 notify 压没了）
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="自动压缩模式"]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩（详情页）"]')`)).toBe(true);
    expect(await ui.query<string>(`document.querySelector('[aria-label="窗口构成视图"] button')?.textContent?.trim() ?? ''`)).toBe("压缩");
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="窗口构成视图"] button.btn-active')`)).toBe(true);
    // 缺省预算 = DEFAULT_BUDGET_BYTES（##343 M1 起 20KB，与生产 auto-compact.yaml 对齐）
    expect(await budgetKb()).toBe("20");
  });

  it("M3：参数区按 mode → modeData → toolResult → renderData 层次展示（归属可见）", async () => {
    const text = await a11yText();
    for (const k of ["mode", "budget", "modeData", "budgetBytes", "toolResult", "render", "renderData", "summary"]) {
      expect(text).toContain(k);
    }
    // 层次结构的字段键（renderData 私有参数）在 DOM 里
    for (const k of ["head", "tail", "maxLineChars", "maxKeepBytes"]) {
      expect(await ui.query<boolean>(`!!document.querySelector('input[aria-label="${k}"]')`)).toBe(true);
    }
    // render 默认 headtail（真源缺省）—— filter 组：读选中的 radio
    expect(await pickedFilter('[data-render-select]')).toBe("headtail");
  });

  it("M3：改工具结果呈现 render（headtail → callpath）写回真源", async () => {
    expect(await pickFilter('[data-render-select]', "callpath")).toBe("ok");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("render: callpath"), { label: "render → callpath 写回" });
    // 非 headtail → renderData 字段从 DOM 退场
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('input[aria-label="head"]')`),
      (v) => v === false,
      { label: "renderData 字段退场" },
    );
    // 切回 headtail（后续用例依赖缺省）
    expect(await pickFilter('[data-render-select]', "headtail")).toBe("ok");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("render: headtail"), { label: "render 切回 headtail" });
  });

  it("M3：改 renderData.head 写回真源（嵌套私有参数）", async () => {
    await ui.query<string>(
      `(() => { const i=document.querySelector('input[aria-label="head"]'); i.value='5'; i.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
    );
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("head: 5"), { label: "renderData.head → 5 写回" });
    // 复位
    await ui.query<string>(
      `(() => { const i=document.querySelector('input[aria-label="head"]'); i.value='3'; i.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
    );
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("head: 3"), { label: "renderData.head 复位" });
  });

  it("M3：切「原始 YAML」显示真源全文（只读），可切回参数", async () => {
    await ui.clickSelector('[aria-label="压缩配置视图"] button:nth-child(2)');
    const raw = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-raw]')?.textContent ?? ''"),
      (t) => t.includes("mode:") && t.includes("policy:"),
      { label: "原始 YAML 上屏" },
    );
    expect(raw).toContain("budgetBytes");
    expect(raw).toContain("toolResult");
    // 切回参数视图
    await ui.clickSelector('[aria-label="压缩配置视图"] button:nth-child(1)');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`),
      (v) => v === true,
      { label: "参数视图回归" },
    );
  });

  it("自动压缩：filter 三态写回真源 $DIY_HOME/auto-compact.yaml（off / notify / auto）", async () => {
    // ##423 块 3：三态全可见（旧 toggle 只能 auto ⇄ off，notify 在界面上根本选不到）
    // 缺省 = notify（见 AutoCompactConfigSchema.mode 的缺省注释），不是 off
    expect(["off", "notify", "auto"]).toContain(await pickedFilter('[data-compact-mode]'));
    expect(await pickFilter('[data-compact-mode]', "auto")).toBe("ok");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: auto"), { label: "auto 写回" });
    expect(await pickFilter('[data-compact-mode]', "notify")).toBe("ok");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: notify"), { label: "notify 写回" });
    expect(await pickFilter('[data-compact-mode]', "off")).toBe("ok");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: off"), { label: "off 写回" });
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
    // ##406 起差异视图**缺省关闭**（大请求的 diff 计算曾把页面卡死）——
    // 预览区先渲染的是闸门 fallback（见 `CompactSessionPanel.tsx:915` 的 `diffEnabled` 缺省 false
    // 与 `:1396-1403` 的 fallback 分支：「计算并显示 diff…」按钮）。
    // 不点它，`[data-compact-preview]` 根本不在 DOM 里 —— 旧用例假设预览恒开，已过时。
    await enableDiffPreview();
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
    await ui.clickSelector('[data-drawer-tab="total"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`),
      (v) => v === false,
      { label: "压缩 tab 退场" },
    );
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(false);
    await ui.clickSelector('[data-drawer-tab="step"]');
    await new Promise((r) => setTimeout(r, 150));
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(false);
    await ui.clickSelector('[data-drawer-tab="compact"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`),
      (v) => v === true,
      { label: "压缩 tab 回归" },
    );
  });

  it("点「压缩（详情页）」→ 账本记预算压缩；**历史不销毁**（聊天页仍可见第1轮）", async () => {
    await ui.clickSelector('[aria-label="压缩（详情页）"]');
    await waitUntil(() => Promise.resolve(compactLog()), (t) => t.includes('"mode":"budget"'), { label: "账本记 budget 压缩" });
    // 「历史不销毁」要按**聊天页真实可见性**断：视口在底部时先看最新一轮（压缩不该动它），
    // 再滚到顶看最早一轮（##301 起块树是视口虚拟化的，DOM 只挂视口附近的行 ——
    // 旧断言假设「全历史恒在 DOM 里」，测的是当时未虚拟化的布局，不是销毁与否）。
    expect(await bodyHas("第8轮问题")).toBe(true);
    expect(await scrollChatToTopUntil("第1轮问题")).toBe(true);
  });

  it("历史未销毁：ops 原文仍含全部 8 轮；压缩事件账有快照（算法 + 过滤器）", async () => {
    const opsRaw = readFileSync(join(fx.HOME, sessionFileRel(uri, "ops")), "utf-8");
    for (let i = 1; i <= 8; i++) expect(opsRaw).toContain(`第${i}轮问题`);

    // 自足（##433）：账本里没有任何压缩事件时就自己压一次 —— `-t '历史未销毁'` 只挑本条的场合，
    // 上一条「点「压缩（详情页）」」被跳过，账本必定是空的，而本用例断言的前提是「压缩过一次」。
    // 走 CLI = 同一条 `compact.run`（与 UI 按钮同一个入口），不是另一条假路径。
    const readEvents = async () =>
        (
            (await fx.sh.getJson(`./diy.sh agent local compact events ${uri}`)).data as {
                events: Array<{ kind: string; policy?: { mode?: string } }>;
            }
        ).events;
    if (!(await readEvents()).some((e) => e.kind === "compact")) {
        const run = await fx.sh.run(`./diy.sh agent local compact run ${uri} --budget-bytes 3072`);
        expect(run.stderr).toBe("");
        expect(run.code).toBe(0);
    }
    // ##431：回包 = `{ events, truncated }`
    const events = await readEvents();
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

// ─── M4：压缩点位进「分表（按步）」────────────────────────────
// 【用户 2026-10-08】压缩可能发生在一轮中间 ⇒ 只能按**步（请求）**标，落到分表。
// 数据：手工种 usage.jsonl（两步，分居压缩事件两侧）+ compact.jsonl（一条压缩事件）。
describe("M4：分表压缩点位", () => {
  let uri2 = "";

  // 同上：夹具放 describe 级 hook，别让「跑单条用例」把它跳过（##433）。
  beforeAll(async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/cp2 --label 点位`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "压缩点位" ${pid}`);
    uri2 = String((t.data as any)?.data?.uri);

    // 点位（uri2）的落盘状态；路径走产品实现 + 实例 home（本进程 DIY_HOME 是另一个）
    const evTs = new Date(Date.now()).toISOString();
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date(Date.now() + 60_000).toISOString();

    // 一条压缩事件（v2 真源形状）
    const ev = {
      kind: "compact",
      v: 2,
      id: evTs,
      ts: evTs,
      by: "ui",
      trigger: "manual",
      policy: { mode: "budget", modeData: { budgetBytes: 3072, toolResult: { render: "asis" } }, summary: false },
      boundary: { keptFromTurnId: null, keepFromOpIndex: 0 },
      size: {
        before: { turns: 3, messages: 6, bytes: 300, estTokens: 75 },
        after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 },
        keptTurns: 0,
        droppedTurns: 3,
      },
      details: { kept: [[1, 9]] },
    };
    writeFileSync(seedFile(uri2, "compact"), JSON.stringify(ev) + "\n", "utf-8");

    // 两步用量账：t1 在事件前、t2 在事件后
    const step = (turnId: string, s: number, ts: string) =>
      JSON.stringify({
        ts,
        turnId,
        step: s,
        model: "test",
        apiFace: "chat",
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
    writeFileSync(seedFile(uri2, "usage"), [step("t1000", 1, t1), step("t2000", 1, t2)].join("\n") + "\n", "utf-8");
    // 让会话有 ops（免得历史区空）
    const opsFile2 = seedFile(uri2, "ops");
    writeFileSync(
      opsFile2,
      [
        { op: "start", id: "t1000", kind: "turn" },
        { op: "start", id: "t1000_u", kind: "text", parent: "t1000", meta: { role: "user" } },
        { op: "delta", id: "t1000_u", fields: { content: "第一轮" } },
        { op: "stop", id: "t1000_u" },
        { op: "stop", id: "t1000" },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf-8",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri2}`);
    await waitUntil(a11yText, (t) => t.includes("第一轮"), { label: "会话上屏" });
  });

  it("打开抽屉 → 分表：事件后那步有「压缩」按钮，展开显示算法/过滤器/规模", async () => {
    await openDrawer();
    await ui.clickSelector('[data-drawer-tab="step"]');
    await waitUntil(
      () => ui.query<number>("document.querySelectorAll('[data-compact-point]').length"),
      (n) => n >= 1,
      { label: "压缩点位按钮出现" },
    );
    // 只有一步被标
    expect(await ui.query<number>("document.querySelectorAll('[data-compact-point]').length")).toBe(1);
    // 展开前无详情
    expect(await ui.query<boolean>("!!document.querySelector('[data-compact-point-detail]')")).toBe(false);
    await ui.clickSelector('[aria-label="压缩点位"]');
    const detail = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-point-detail]')?.textContent ?? ''"),
      (t) => t.includes("上限"),
      { label: "压缩详情展开" },
    );
    expect(detail).toContain("budget");
    expect(detail).toContain("3 KB");
    expect(detail).toContain("保留区间");
    // 再点收起
    await ui.clickSelector('[aria-label="压缩点位"]');
    await waitUntil(
      () => ui.query<boolean>("!!document.querySelector('[data-compact-point-detail]')"),
      (v) => v === false,
      { label: "压缩详情收起" },
    );
    await ui.clickSelector('[aria-label="关闭窗口构成"]');
  });
});

// ─── ##272 B1 / ##339：投递压缩可见性进「分表（按步）」────────────
// 「投递」徽标 = 配置驱动压缩的**事实**（每轮首按当前配置重建，与 compact 事件无关）：
// 只在**轮首步**（step===1，且账本落了 `historySelection`）标注；其余步不标。
// 与上面的「压缩」事件列语义分离：两列可同时出现。
describe("##339：分表投递徽标（配置驱动压缩的事实）", () => {
  let uri3 = "";

  it("种 usage.jsonl：轮首步带 historySelection（丢过），其余步不带", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/cp3 --label 投递`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "投递徽标" ${pid}`);
    uri3 = String((t.data as any)?.data?.uri);

    const ts = new Date().toISOString();
    const step = (turnId: string, s: number, extra: Record<string, unknown>) =>
      JSON.stringify({
        ts,
        turnId,
        step: s,
        model: "test",
        apiFace: "chat",
        usage: { inputTokens: 1000, outputTokens: 100 },
        ...extra,
      });
    writeFileSync(
      seedFile(uri3, "usage"),
      [
        // 轮首步：投递被压过（丢 3 条、保留 1 段）+ 一条压缩事件命中的位置
        step("t3000", 1, {
          historySelection: { budgetBytes: 3072, keptBytes: 800, keptRuns: 1, droppedMessages: 3, totalMessages: 5 },
        }),
        // 同轮第二步：**不带**（配置驱动的重建点只在轮首）
        step("t3000", 2, {}),
      ].join("\n") + "\n",
      "utf-8",
    );
    const opsFile3 = seedFile(uri3, "ops");
    writeFileSync(
      opsFile3,
      [
        { op: "start", id: "t3000", kind: "turn" },
        { op: "start", id: "t3000_u", kind: "text", parent: "t3000", meta: { role: "user" } },
        { op: "delta", id: "t3000_u", fields: { content: "投递话题" } },
        { op: "stop", id: "t3000_u" },
        { op: "stop", id: "t3000" },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf-8",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri3}`);
    await waitUntil(a11yText, (t) => t.includes("投递话题"), { label: "会话上屏" });
  });

  it("分表：**只有轮首步**有「历史」徽标（其余步无）；悬停给出维度/预算/丢几条/must 级/三触发器", async () => {
    await openDrawer();
    await ui.clickSelector('[data-drawer-tab="step"]');
    await waitUntil(
      () => ui.query<number>("document.querySelectorAll('[data-delivery-compact]').length"),
      (n) => n >= 1,
      { label: "投递徽标出现" },
    );
    // 恰好一处（= 轮首步）；第二步不标
    expect(await ui.query<number>("document.querySelectorAll('[data-delivery-compact]').length")).toBe(1);
    const badge = await ui.query<string>("document.querySelector('[data-delivery-compact]')?.textContent?.trim() ?? ''");
    // ##423：维度写进词里 —— 不再有裸「全量」/「投递」这种跨维度歧义词
    expect(badge).toContain("历史");
    expect(badge).toContain("丢 3 条");
    expect(badge).not.toContain("全量");
    const tip = await ui.query<string>("document.querySelector('[data-delivery-compact]')?.getAttribute('title') ?? ''");
    expect(tip).toContain("历史裁剪");
    expect(tip).toContain("3 KB");
    expect(tip).toContain("丢 3/5");
    expect(tip).toContain("保留 1 段");
    // ③【关键】must 级不吃预算（「压完还超预算、于是每轮都在压」的根因）
    expect(tip).toContain("预算只约束非 must 级");
    // ④ 三触发器 + 阈值（旧版 hover 只说预算多少）
    expect(tip).toContain("systemContextChanged");
    expect(tip).toContain("cacheExpired");
    expect(tip).toContain("contextWindowOver");
    expect(tip).toContain("本步");

    // ③ 统计补齐：会话/本轮的投递次数（= 步数）与压缩次数
    const stats = await ui.query<string>("document.querySelector('[data-delivery-stats]')?.textContent ?? ''");
    expect(stats).toContain("2 次投递");
    expect(stats).toContain("1 轮");
    expect(stats).toContain("压缩 0 次");
    await ui.clickSelector('[aria-label="关闭窗口构成"]');
  });
});

// ═══════════════════════════════════════════════════════════════
// 装配管道（##344 M2）：级列表编辑器 + 即时预览 + 与 CLI 同一真源
//
// 验收（##344 body）：UI 级列表**可增删改**（选 type / 必保 / limit / clip / 私有 data）+
// **即时预览投递效果**；破坏性操作（删级）走 ConfirmDialog；CLI `compact plan get|set|check`
// 与 UI 读写的是**同一份** `history.keep[]`。
// ═══════════════════════════════════════════════════════════════
describe("装配管道（##344 M2）：级列表增删改 + 即时预览 + 与 CLI 同一真源", () => {
  /** 第 i 级里的某个控件（多级同形 ⇒ 必须按行取，不能全局 querySelector） */
  const rowSel = (i: number, sel: string) =>
    `document.querySelectorAll('[data-keep-stage]')[${i}]?.querySelector(${JSON.stringify(sel)})`;
  /**
   * 给某个控件设值并派发 change（走真实 DOM 事件路径）。
   *
   * ##423 块 3：下拉/勾选框换成了 daisyUI `filter`（radio 组）—— `[data-keep-type-select]` 这类钩子
   * 现在挂在**组容器**上，所以这里分两路：容器 ⇒ 点 `input[data-filter-value=<v>]`（真实点击，
   * 让 browser 自己处理同组互斥）；`input/select` ⇒ 老路径 el.value + change。
   */
  const fire = (sel: string, value: string) =>
    ui.query<string>(
      `(() => { const el=${sel}; if(!el) return 'no';
        if (el.matches('input,select,textarea')) { el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; }
        const r = el.querySelector('input[data-filter-value=' + JSON.stringify(${JSON.stringify(value)}) + ']');
        if (!r) return 'no-option'; r.click(); return 'ok'; })()`,
    );
  /** 某个 filter 组的当前选中值（radio 组没有 `.value` 可读） */
  const picked = (sel: string) =>
    ui.query<string>(
      `(() => { const el=${sel}; if(!el) return 'no';
        const r = el.querySelector('input[type=radio]:checked'); return r ? r.getAttribute('data-filter-value') : ''; })()`,
    );

  /** 该 describe 接在分表用例之后 —— 那时抽屉在「分表」tab 上，先切回「压缩」tab */
  async function gotoCompactTab(): Promise<void> {
    if (!(await ui.query<boolean>(`!!document.querySelector('[data-drawer-tab="compact"]')`))) {
      await ui.query<string>(
        `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('窗口占用')); if(!b) return 'no'; b.click(); return 'ok'; })()`,
      );
      await waitUntil(a11yText, (t) => t.includes("窗口构成"), { label: "窗口构成抽屉打开" });
    }
    await ui.clickSelector('[data-drawer-tab="compact"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-keep-stage]')`),
      (v) => v === true,
      { label: "级列表上屏" },
    );
  }

  it("默认：配置无 history.keep ⇒ 显示「缺省回落」并把缺省管道**回显成数据**（steps 必保 full + ladder）", async () => {
    await gotoCompactTab();
    const text = await a11yText();
    expect(text).toContain("装配管道");
    expect(text).toContain("缺省回落");
    expect(await ui.query<number>(`document.querySelectorAll('[data-keep-stage]').length`)).toBe(2);
    expect(await ui.query<string>(`document.querySelectorAll('[data-keep-stage]')[0].getAttribute('data-keep-type')`)).toBe("steps");
    expect(await ui.query<string>(`document.querySelectorAll('[data-keep-stage]')[1].getAttribute('data-keep-type')`)).toBe("ladder");
    // ##423 块 3：勾选框/下拉换成 filter 按钮组 ⇒ 读「选中的 radio」而不是 .checked / .value
    expect(await picked(`document.querySelectorAll('[data-keep-must]')[0]`)).toBe("must");
    expect(await picked(`document.querySelectorAll('[data-keep-clip]')[0]`)).toBe("full");
    // 阶梯级不声明 clip ⇒ 界面显示「回落全局」（不是写死 headtail）
    expect(await picked(`document.querySelectorAll('[data-keep-clip]')[1]`)).toBe("inherit");
    expect(await ui.query<string>(`document.querySelectorAll('[data-keep-n]')[0].value`)).toBe("6");
  });

  it("##423 块 2/3：「什么时候会压」讲清判据、范例预览左右对照、计数上屏", async () => {
    await gotoCompactTab();
    // ① 什么时候会压：三触发器 + 手动，各自带「开/关/手动」与当前值
    const text = await a11yText();
    expect(await ui.query<boolean>(`!!document.querySelector('[data-when-compact]')`)).toBe(true);
    expect(
      await ui.query<string[]>(`[...document.querySelectorAll('[data-when-row]')].map(e=>e.getAttribute('data-when-row'))`),
    ).toEqual(["systemContextChanged", "cacheExpired", "contextWindowOver", "manual"]);
    expect(text).toContain("系统上下文变");
    expect(text).toContain("缓存过期");
    expect(text).toContain("窗口超限");
    expect(text).toContain("压成什么样");
    // ② 范例预览：左 = 固定样例全部 20 条，右 = 压完留下的（上限小 ⇒ 留得少）
    const before = await ui.query<number>(`document.querySelectorAll('[data-example-before] [data-example-msg]').length`);
    const after = await ui.query<number>(`document.querySelectorAll('[data-example-after] [data-example-msg]').length`);
    expect(before).toBe(20);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    // 每条都标了模拟 token 尺寸
    expect(text).toMatch(/\d+ tok/);
    // ③ 计数：本会话投递次数 / 轮数 / 压缩次数 = 账本同源
    expect(await ui.query<boolean>(`!!document.querySelector('[data-compact-stats]')`)).toBe(true);
    expect(text).toContain("次投递（= 步数）");
    expect(text).toContain("压缩");
  });

  it("「+ 新增级」→ 写回 history.keep[]（来源变「来自配置」）", async () => {
    await ui.clickSelector("[data-keep-add]");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("history:") && t.includes("keep:"), {
      label: "history.keep 落盘",
    });
    expect(autoYaml()).toContain("must: true");
    expect(await ui.query<number>(`document.querySelectorAll('[data-keep-stage]').length`)).toBe(3);
    expect((await a11yText()).includes("来自配置")).toBe(true);
    // 新增的是「最近 6 步」（必保），label 一处文案
    expect(await ui.query<string>(`document.querySelectorAll('[data-keep-stage]')[2].getAttribute('data-keep-type')`)).toBe("steps");
  });

  it("换 type（ladder → recent）→ data **整包换**（默认 n=10），再改 n / role 写回 data", async () => {
    await fire(rowSel(1, "[data-keep-type-select]"), "recent");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("type: recent"), { label: "type → recent 写回" });
    // ⚠️ js-yaml 把键 `n` 落成 `'n':`（YAML 1.1 的 y/n 布尔别名 ⇒ 必须引号化）；值语义不变
    expect(autoYaml()).toContain("'n': 10");
    // 私有参数控件随 type 出现 —— **等 DOM，不等文件**（文件已写 ≠ 界面已重渲染，
    // 同一原则在本文件别处已注明；`setKeep` 走 RPC 后再回灌，紧跟着查 DOM 会读到上一帧）。
    await waitUntil(
      () => ui.query<boolean>(`!!${rowSel(1, "[data-keep-n]")}`),
      (v) => v === true,
      { label: "recent 级 n 控件出现" },
    );
    expect(await ui.query<boolean>(`!!${rowSel(1, "[data-keep-role]")}`)).toBe(true);
    await fire(rowSel(1, "[data-keep-n]"), "3");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("'n': 3"), { label: "n=3 写回" });
    await fire(rowSel(1, "[data-keep-role]"), "user");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("role: user"), { label: "role=user 写回" });
  });

  it("必保勾选 / 裁法选择 → 写回必须字段 `must` 与公共字段 `clip`", async () => {
    // 第 2 级（recent）取消必保（它本来没有 must）→ 勾上再取消
    // 第 2 级「计预算 → 必保」（filter 组：点对应 radio）
    expect(await fire(rowSel(1, "[data-keep-must]"), "must")).toBe("ok");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => (t.match(/must: true/g) || []).length >= 2, { label: "recent 级变必保" });
    // 第 2 级裁法 → full（写回 clip 形状）
    await fire(rowSel(1, "[data-keep-clip]"), "full");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("type: full"), { label: "clip → full 写回" });
    // 切到 headtail ⇒ 出现私有参数控件（head/tail/...）
    await fire(rowSel(1, "[data-keep-clip]"), "headtail");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("type: headtail"), { label: "clip → headtail 写回" });
    // 私有参数控件随 clip 出现（等 DOM，不等文件 —— 文件已写 ≠ 界面已重渲染）
    await waitUntil(
      () => ui.query<boolean>(`!!${rowSel(1, "[data-keep-ht='head']")}`),
      (v) => v === true,
      { label: "headtail 私有参数控件出现" },
    );
    await fire(rowSel(1, "[data-keep-ht='head']"), "2");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("head: 2"), { label: "headtail.head=2 写回" });
    // 回落全局（删掉 clip 键）；判据用**本级的 `head: 2`**（不能用 `type: headtail`：真源头部注释里就有这串字）
    await fire(rowSel(1, "[data-keep-clip]"), "inherit");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => !t.includes("head: 2"), { label: "clip 回落（键消失）" });
  });

  it("删级：走 ConfirmDialog（应用内弹窗，非原生 confirm）确认后才写回", async () => {
    const before = autoYaml();
    // 第 3 级的删除按钮。用**合成 click**（`el.click()`）而非真实鼠标：级列表在 340px 左栏里，
    // 行可能横向溢出 ⇒ 真实点击的命中点会被裁到别的元素上（同文件里开抽屉也出于同类原因用合成 click）。
    // 重试上限 10 次：级列表刚被上一条用例改过（`setKeep` → RPC → 回灌），紧跟着点删除可能落在
    // 重渲染中间态（按钮还没挂上 / 事件绑在旧行上）⇒ 弹窗不出来。这是**夹具时序**，不是被测行为：
    // 下面「未确认前不改文件」与「确认后才写回」两条断言一个字没放宽。
    let dialogUp = false;
    for (let i = 0; i < 10 && !dialogUp; i++) {
      await ui.query<string>(
        `(() => { const b=${rowSel(2, "[data-keep-del]")}; if(!b) return 'no'; b.click(); return 'ok'; })()`,
      );
      dialogUp = await waitUntil(
        () => ui.query<boolean>(`!!document.querySelector('button.btn-error')`),
        (v) => v === true,
        { label: "ConfirmDialog 出现", timeoutMs: 500 },
      );
    }
    expect(dialogUp).toBe(true);
    // 未确认前**不改文件**（破坏性操作要显式确认）
    expect(autoYaml()).toBe(before);
    await ui.clickSelector("button.btn-error");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t !== before, { label: "确认后写回" });
    await waitUntil(
      () => ui.query<number>(`document.querySelectorAll('[data-keep-stage]').length`),
      (n) => n === 2,
      { label: "级数 → 2" },
    );
  });

  it("改管道 ⇒ 预览**即时重算**（阶梯级裁法改 path → 工具结果变「只留调用」）", async () => {
    // 预览区的 diff 计算是**按实例**的开关（##406）：本 describe 的面板是新挂的，得再开一次。
    await enableDiffPreview();
    await expandAll();
    const before = await ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''");
    // 先证明预览确实渲染了：否则下面「不含 X」是空串给的假绿。
    expect(before.length).toBeGreaterThan(0);
    expect(before).not.toContain("输出已省略（只留调用）");
    await fire(rowSel(1, "[data-keep-clip]"), "path");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("type: path"), { label: "clip → path 写回" });
    // 预览以「当前配置」现算 ⇒ 立刻反映（不必点任何按钮）
    const after = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("输出已省略（只留调用）"),
      { label: "预览即时重算（path 生效）" },
    );
    expect(after.length).toBeGreaterThan(0);
    // 复位（后续 CLI 用例按 headtail 语义断言）
    await fire(rowSel(1, "[data-keep-clip]"), "inherit");
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => !/type: path/.test(t), { label: "裁法复位" });
  });

  it("CLI 与 UI 同一真源：compact plan get 读到 UI 写的那份；plan check 通过；非法 set 拒绝且不改文件", async () => {
    const get = (await fx.sh.getJson(`./diy.sh agent local compact plan get ${uri}`)).data as {
      source: string;
      keep: Array<{ type: string }>;
      raw: string;
    };
    expect(get.source).toBe("config");
    expect(get.keep.map((s) => s.type)).toEqual(["steps", "recent"]);
    expect(get.raw).toContain("history:");

    const chk = await fx.sh.run(`./diy.sh agent local compact plan check ${uri}`);
    expect(chk.stderr).toBe("");
    expect(chk.code).toBe(0);

    // 非法 plan：写文件 → set 拒绝（exit≠0）且**配置一字不改**
    const badPath = join(fx.HOME, "bad-keep.yaml");
    writeFileSync(badPath, "- type: nope\n", "utf-8");
    const before = autoYaml();
    const bad = await fx.sh.run(`./diy.sh agent local compact plan set ${uri} ${badPath}`);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("未知取法");
    expect(autoYaml()).toBe(before);

    // 合法 plan：写文件 → set 通过 → get 读回（**往返一致**）
    const goodPath = join(fx.HOME, "good-keep.yaml");
    writeFileSync(goodPath, "keep:\n  - type: steps\n    must: true\n    clip: {type: full}\n    data: {n: 6}\n  - type: ladder\n", "utf-8");
    const ok = await fx.sh.run(`./diy.sh agent local compact plan set ${uri} ${goodPath}`);
    expect(ok.code).toBe(0);
    const back = (await fx.sh.getJson(`./diy.sh agent local compact plan get ${uri}`)).data as { source: string; keep: Array<{ type: string; must?: boolean }> };
    expect(back.source).toBe("config");
    expect(back.keep).toEqual([
      { type: "steps", must: true, clip: { type: "full" }, data: { n: 6 } },
      { type: "ladder" },
    ]);
    // 校验盘上配置（不带 keep 参数）也通过
    expect((await fx.sh.run(`./diy.sh agent local compact plan check ${uri}`)).code).toBe(0);
  });

  it("##363：点「重置为缺省」→ ConfirmDialog（点明影响面）→ 确认 → keep 键消失、标记变「缺省回落」、级列表回显缺省", async () => {
    await gotoCompactTab();
    expect(autoYaml()).toContain("keep:");
    // 合成 click（同上：左栏窄、真实命中点会被裁）
    await ui.query<string>(
      `(() => { const b=document.querySelector('[data-keep-reset]'); if(!b) return 'no'; if(b.disabled) return 'disabled'; b.click(); return 'ok'; })()`,
    );
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('button.btn-error')`),
      (v) => v === true,
      { label: "重置 ConfirmDialog 出现" },
    );
    // 文案点明影响面（全局 + 可 restore 找回）
    expect(await bodyHas("所有任务")).toBe(true);
    expect(await bodyHas("restore")).toBe(true);
    // 未确认前**不动文件**
    const before = autoYaml();
    expect(before).toContain("keep:");
    await ui.clickSelector("button.btn-error");
    // 删键（不是写死 DEFAULT_KEEP 字面量）⇒ 文件里不再有 `keep:`
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => !t.includes("keep:"), { label: "history.keep 键消失" });
    // 标记回落 + 级列表回显缺省（steps + ladder）
    await waitUntil(() => a11yText(), (t) => t.includes("缺省回落"), { label: "标记变缺省回落" });
    await waitUntil(
      () => ui.query<number>(`document.querySelectorAll('[data-keep-stage]').length`),
      (n) => n === 2,
      { label: "级列表回显缺省（2 级）" },
    );
    expect(await ui.query<string>(`document.querySelectorAll('[data-keep-stage]')[0].getAttribute('data-keep-type')`)).toBe("steps");
    // CLI 读同一真源：source 回落 default
    const get = (await fx.sh.getJson(`./diy.sh agent local compact plan get ${uri}`)).data as { source: string };
    expect(get.source).toBe("default");
  });
});
