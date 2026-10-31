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

/** 历史上限输入框当前值（**token**，##432 刀 2 的唯一旋钮） */
const limitTokensValue = () => ui.query<string>(`document.querySelector('input[aria-label="历史上限token"]')?.value ?? ''`);

/** 在历史上限输入框里设 token 并提交（change） */
async function setLimitTokens(tokens: number): Promise<void> {
  await ui.query<string>(
    `(() => { const i=document.querySelector('input[aria-label="历史上限token"]'); if(!i) return 'x'; i.value=${JSON.stringify(String(tokens))}; i.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
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
      () => ui.query<boolean>(`!!document.querySelector('[data-history-limit]')`),
      (v) => v === true,
      { label: "压缩 tab 上屏" },
    );
    const text = await a11yText();
    expect(text).toContain("自动压缩");
    expect(text).toContain("费用对比");
    // ##442：删掉 off/notify/auto 三态 filter，只剩「到点就压」的说明
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="自动压缩模式"]')`)).toBe(false);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-compact-mode]')`)).toBe(true);
    expect(text).toContain("到点就压");
    expect(await ui.query<boolean>(`!!document.querySelector('[data-history-limit]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="压缩（详情页）"]')`)).toBe(true);
    expect(await ui.query<string>(`document.querySelector('[aria-label="窗口构成视图"] button')?.textContent?.trim() ?? ''`)).toBe("压缩");
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="窗口构成视图"] button.btn-active')`)).toBe(true);
    // ##442：保留量固定为窗口 × 0.16（不再有可编辑的 token 上限）
    expect(text).toContain("固定 W × 0.16");
    expect(await ui.query<boolean>(`!!document.querySelector('input[aria-label="历史上限token"]')`)).toBe(false);
  });

  it("M3：参数区按 mode → modeData → toolResult → renderData 层次展示（归属可见）", async () => {
    const text = await a11yText();
    for (const k of ["modeData", "toolResult", "render", "renderData", "summary"]) {
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
    expect(raw).toContain("summary");
    expect(raw).toContain("toolResult");
    // 切回参数视图
    await ui.clickSelector('[aria-label="压缩配置视图"] button:nth-child(1)');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-history-limit]')`),
      (v) => v === true,
      { label: "参数视图回归" },
    );
  });

  it("自动压缩：##442 零旋钮 → 面板只说「到点就压」，真源没有 triggers / windowOverRatio", async () => {
    const text = await a11yText();
    expect(text).toContain("到点就压");
    expect(text).not.toContain("自动压缩 off");
    const raw = await waitUntil(
      () => Promise.resolve(autoYaml()),
      (t) => t.includes("summary"),
      { label: "真源有 summary" },
    );
    const dataLines = raw
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .join("\n");
    expect(dataLines).not.toContain("windowOverRatio");
    expect(dataLines).not.toContain("triggers:");
    expect(raw).not.toContain("mode: notify");
  });

  it("摘要模式：model / self 写回真源", async () => {
    const sel = `document.querySelector('[data-history-limit] select')`;
    await ui.query<string>(
      `(() => { const s=${sel}; s.value='self'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
    );
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: self"), { label: "写回 self" });
    await ui.query<string>(
      `(() => { const s=${sel}; s.value='model'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'x'; })()`,
    );
    await waitUntil(() => Promise.resolve(autoYaml()), (t) => t.includes("mode: model"), { label: "写回 model" });
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

  it("切「构成」：压缩内容退场（无用量记录 → 空态，不画表），可切回", async () => {
    await ui.clickSelector('[data-drawer-tab="parts"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-history-limit]')`),
      (v) => v === false,
      { label: "压缩 tab 退场" },
    );
    // ##443 刀 3：构成 = 统一表的一个视图；没有用量记录时**整张表都不画**（空态文案）
    expect(await ui.query<boolean>("!!document.querySelector('table')")).toBe(false);
    expect(await ui.query<boolean>("!!document.querySelector('[data-usage-empty]')")).toBe(true);
    await ui.clickSelector('[data-drawer-tab="compact"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-history-limit]')`),
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
    await ui.clickSelector('[data-drawer-tab="parts"]');
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
    // 旧事件没有边界上限字段（边界在 turns.jsonl）；已废弃的 budgetBytes 不再显示 KB
    expect(detail).toContain("保留区间");
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
// ##476：轮首步落了 `historySelection` 但 **droppedMessages=0（没裁剪）** 也不标 ——
// 「历史·无裁剪」已删，徽标只在真有裁剪的那几步出现（DOM 里根本不插节点）。
// 与上面的「压缩」事件列语义分离：两列可同时出现。
describe("##339：分表投递徽标（配置驱动压缩的事实）", () => {
  let uri3 = "";

  it("种 usage.jsonl：t3000 轮首步真裁剪过（带 historySelection）、同轮第二步不带、t3001 轮首步没裁剪（dropped=0）", async () => {
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
          // ##423：丢 / 留都说 token（与 limitTokens 同口径）—— 徽章不再拿字节跟 token 上限比
          historySelection: {
            limitTokens: 3072,
            keptTokens: 900,
            droppedTokens: 2100,
            keptBytes: 800,
            keptRuns: 1,
            droppedMessages: 3,
            totalMessages: 5,
          },
        }),
        // 同轮第二步：**不带**（配置驱动的重建点只在轮首）
        step("t3000", 2, {}),
        // ##476：这一轮**没被裁剪**（轮首步有 historySelection，但 droppedMessages=0）
        // → 旧实现会亮「历史·无裁剪」，现在必须整块不插节点
        step("t3001", 1, {
          historySelection: {
            limitTokens: 3072,
            keptTokens: 1200,
            droppedTokens: 0,
            keptBytes: 800,
            keptRuns: 1,
            droppedMessages: 0,
            totalMessages: 3,
          },
        }),
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
        { op: "start", id: "t3001", kind: "turn" },
        { op: "start", id: "t3001_u", kind: "text", parent: "t3001", meta: { role: "user" } },
        { op: "delta", id: "t3001_u", fields: { content: "未裁剪话题" } },
        { op: "stop", id: "t3001_u" },
        { op: "stop", id: "t3001" },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf-8",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri3}`);
    await waitUntil(a11yText, (t) => t.includes("投递话题"), { label: "会话上屏" });
  });

  it("分表：只有**真裁剪过的轮首步**有「历史」徽标（其余步 / 没裁剪的轮都无）；悬停给出维度 / token 口径 / 什么时候会压", async () => {
    await openDrawer();
    await ui.clickSelector('[data-drawer-tab="parts"]');
    await waitUntil(
      () => ui.query<number>("document.querySelectorAll('[data-delivery-compact]').length"),
      (n) => n >= 1,
      { label: "投递徽标出现" },
    );
    // 恰好一处（= 真裁剪过的 t3000 轮首步）：同轮第二步不标、**没裁剪的 t3001 轮首步也不标**（##476）
    expect(await ui.query<number>("document.querySelectorAll('[data-delivery-compact]').length")).toBe(1);
    // ##476：页面上再没有「历史·无裁剪」这种常亮字（整块不渲染，不是空字符串）
    const allBadges = await ui.query<string>(
      "[...document.querySelectorAll('[data-delivery-compact]')].map((e) => e.textContent ?? '').join('|')",
    );
    expect(allBadges).not.toContain("无裁剪");
    const badge = await ui.query<string>("document.querySelector('[data-delivery-compact]')?.textContent?.trim() ?? ''");
    // ##423：维度写进词里 —— 不再有裸「全量」/「投递」这种跨维度歧义词；数一律 token
    expect(badge).toContain("历史");
    expect(badge).toContain("丢 2.1k tok");
    expect(badge).not.toContain("全量");
    const tip = await ui.query<string>("document.querySelector('[data-delivery-compact]')?.getAttribute('title') ?? ''");
    expect(tip).toContain("历史裁剪");
    expect(tip).toContain("3,072 token");
    expect(tip).toContain("丢 3/5");
    expect(tip).toContain("2.1k tok");
    expect(tip).toContain("1 段");
    // ① `must` / 字节预算这些词已随 ##432 清理（唯一旋钮是 token 上限）
    expect(tip).not.toContain("must");
    expect(tip).not.toContain("预算");
    // ② 事件制：hover 讲「什么时候会压」（##442 删 mode 后徽章只讲历史裁剪维度）
    expect(tip).toContain("压缩事件");
    expect(tip).toContain("只看保留段自己");
    expect(tip).not.toContain("mode=");

    // ③ 统计补齐：会话/本轮的投递次数（= 步数）与压缩次数
    const stats = await ui.query<string>("document.querySelector('[data-delivery-stats]')?.textContent ?? ''");
    expect(stats).toContain("3 次投递"); // t3000 第 1/2 步 + t3001 第 1 步
    expect(stats).toContain("2 轮");
    expect(stats).toContain("压缩");
    await ui.clickSelector('[aria-label="关闭窗口构成"]');
  });
});

// ═══════════════════════════════════════════════════════════════
// 压缩面板（##344 M2 / ##423 块 2-3 / ##432 刀 2）
//
// ##432 起：级列表编辑器**退场**（历史投递只按 `history.limit.limitTokens` 一条上限）。
// 这里守的是「原生机制仍可看」+「编辑面确实没了」+ CLI 面仍在（`compact plan get|set|check`）。
// ═══════════════════════════════════════════════════════════════
describe("压缩面板（##344 M2）：固定保留量 + 摘要模式 + 范例预览", () => {
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
      () => ui.query<boolean>(`!!document.querySelector('[data-history-limit]')`),
      (v) => v === true,
      { label: "压缩 tab 上屏" },
    );
  }

  it("##423 块 2/3：「什么时候会压」讲清判据、范例预览左右对照、计数上屏", async () => {
    await gotoCompactTab();
    // ① 什么时候会压：##432 之后是**事件制**（首次 / 保留段再顶过上限 / 每步按边界切 / 手动）
    const text = await a11yText();
    expect(await ui.query<boolean>(`!!document.querySelector('[data-when-compact]')`)).toBe(true);
    expect(
      await ui.query<string[]>(`[...document.querySelectorAll('[data-when-row]')].map(e=>e.getAttribute('data-when-row'))`),
    ).toEqual(["first", "retained", "reuse", "manual"]);
    expect(text).toContain("自动触发");
    expect(text).toContain("保留段再顶到触发线");
    expect(text).toContain("每步投递");
    expect(text).toContain("压成什么样");
    // 三触发器归位：只写审计、不改投递切点（与投递划清界线）
    // a11y 文本每节点会被截短 ⇒ 这句从 title（完整形）上验
    expect(
      await ui.query<string>(`document.querySelector('[data-when-audit]')?.getAttribute('title') ?? ''`),
    ).toContain("不改投递切点");
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

  it("`compact plan` 子命令已删（##432 清理：装配计划面整体退场）", async () => {
    const r = await fx.sh.run(`./diy.sh agent local compact plan get ${uri}`);
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/unknown command|未知|没有.*plan/i);
  });
});
