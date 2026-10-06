// tests/cli.intent.ui-compact.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 压缩会话 UI 意图验证（真实 renderer + CDP 原生点击）
//
// 需求（##246）：token 窗口面板旁的「压缩」大按钮 → 打开压缩面板（保留 N 轮 + 工具结果选项
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
    expect(text).toContain("② 工具结果");
    expect(text).toContain("③ 计算历史摘要");
    // 两个 view 用统一的折叠框模式（标题条可点）
    expect(text).toContain("压缩选项");
    expect(text).toContain("压缩后估算");
    // 默认保留 6 轮、共 8 轮（数字与「保留最近」在 a11y 树里是不同节点）
    expect(text).toContain("保留最近");
    expect(text).toContain("共 8 轮");
  });

  it("压缩后估算表：中文层名 + 合计居首 + ├/└ 层级符号", async () => {
    const text = await a11yText();
    for (const h of ["被压缩的历史消息", "压缩前", "压缩后", "预估节省"]) expect(text).toContain(h);
    // 每个字段都有中文词汇（不给英文键）
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

  it("变更点：只在节点折叠时标出，展开即隐去；且标在行尾（不破缩进）", async () => {
    await expandAll();
    // 最大展开 → 无变更点（内容都已可见）
    expect(await ui.query<number>(`document.querySelectorAll('[data-compact-preview] [title*="内含变更"]').length`)).toBe(0);

    // 折叠一个节点 → 变更点出现
    await ui.clickSelector('[data-compact-preview] button[aria-label="折叠节点"]');
    const dot = await waitUntil(
      () =>
        ui.query<string>(
          "document.querySelector('[data-compact-preview] [title*=\"内含变更\"]')?.textContent?.trim() ?? ''",
        ),
      (t) => t.includes("●"),
      { label: "折叠变更点出现" },
    );
    expect(dot).toContain("●");
    // 位置：变更点必须在该行的**内容之后**（行尾），不是行首（否则破坏 YAML 缩进视觉）
    const afterText = await ui.query<boolean>(
      `(() => {
         const m = document.querySelector('[data-compact-preview] [title*="内含变更"]');
         if (!m) return false;
         const row = m.closest('[data-diff]') ?? m.parentElement;
         return row ? row.textContent.trim().indexOf('●') > 0 : false;
       })()`,
    );
    expect(afterText).toBe(true);

    // 再展开 → 变更点隐去
    await ui.clickSelector('[data-compact-preview] button[aria-label="展开节点"]');
    await waitUntil(
      () => ui.query<number>(`document.querySelectorAll('[data-compact-preview] [title*="内含变更"]').length`),
      (v) => v === 0,
      { label: "展开后变更点隐去" },
    );
    await expandAll();
  });

  it("展开节点时列表不整表重建（DOM 节点存活 → 焦点/滚动不被拽回顶部）", async () => {
    await expandAll();
    // 给**末行**打标记（末行不会被折叠隐藏：折的是靠前的节点，且末行在保持可见的行里）
    await ui.query<string>(
      `(() => { const rows=[...document.querySelectorAll('[data-compact-preview] [data-diff]')]; const first=rows[0]; if(first) first.setAttribute('data-probe','kept'); return 'x'; })()`,
    );
    expect(await ui.query<number>(`document.querySelectorAll('[data-probe="kept"]').length`)).toBeGreaterThan(0);
    // 折叠**最靠后**的可折叠节点（它的子树在末尾，首行不受影响但仍会引起列表增删 → 测 <For> 是否重建）
    await ui.query<string>(
      `(() => { const bs=[...document.querySelectorAll('[data-compact-preview] button[aria-label="折叠节点"]')]; bs[bs.length-1]?.click(); return 'x'; })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    // 标记仍在 → Solid <For> 按稳定引用只增删变化行，没有整表重建
    expect(await ui.query<number>(`document.querySelectorAll('[data-probe="kept"]').length`)).toBeGreaterThan(0);
    await expandAll();
  });

  it("头尾裁剪 diff：保留的头 3/尾 3 行以「未变」呈现、只有中间删除（+ left context 可见）", async () => {
    // 本用例的数据：每轮一个 30 行 tool 输出；选 headtail → 头 3 + 尾 3 保留、中间删除
    await ui.query<string>(
      `(() => { const r=[...document.querySelectorAll('input[type=radio]')].find(x=>x.parentElement.textContent.includes('头尾裁剪')); r?.click(); return 'x'; })()`,
    );
    // 只看差异默认开 —— 头/尾保留行应作为上下文（data-diff="same"）出现
    const info = await waitUntil(
      () =>
        ui.query<string>(
          `JSON.stringify([...document.querySelectorAll('[data-compact-preview] [data-diff]')].map(e=>e.getAttribute('data-diff')+':'+e.textContent.trim().replace(/\s+/g,' ').slice(-8)))`,
        ),
      (t) => t.includes("row 0") && t.includes("row 29"),
      { label: "头尾保留行作为上下文出现" },
    );
    const rows = JSON.parse(info) as string[];
    const sameTexts = rows.filter((r) => r.startsWith("same:")); // 未变行（原色）
    // 头 3 行保留 = same（未变，原色）
    expect(sameTexts.some((r) => /row 0$/.test(r.trim()))).toBe(true);
    // 尾 3 行保留 = same（未变，原色）
    expect(sameTexts.some((r) => /row 29$/.test(r.trim()))).toBe(true);
    // 中间被删 = del（红）
    expect(rows.some((r) => r.startsWith("del:") && r.includes("row 3"))).toBe(true);
    // 复位为原样
    await ui.query<string>(
      `(() => { const r=[...document.querySelectorAll('input[type=radio]')].find(x=>x.parentElement.textContent.includes('原样')); r?.click(); return 'x'; })()`,
    );
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
    expect(Math.abs(h1 - vh)).toBeLessThanOrEqual(2); // 最大化 = 占满可视高
    expect(await ui.query<boolean>(`!!${btn("1")}`)).toBe(true);
    // 还原
    await ui.query<string>(`${btn("1")}?.click(); 'x'`);
    await new Promise((r) => setTimeout(r, 200));
    expect(Math.abs((await h()) - h0)).toBeLessThanOrEqual(2);
  });

  it("勾选历史摘要 → 预览出现 <summary> 骨架 + 「生成摘要」按钮（未生成时显示占位，不花钱）", async () => {
    await expandAll();
    const before = await ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''");
    expect(before).not.toContain("<summary");

    // 勾选「③ 计算历史摘要」
    await ui.query<string>(
      `(() => { const cb=[...document.querySelectorAll('input[type=checkbox]')].find(c=>(c.closest('label')?.textContent||'').includes('计算历史摘要')); cb?.click(); return 'x'; })()`,
    );
    const txt = await waitUntil(
      () => ui.query<string>("document.querySelector('[data-compact-preview]')?.textContent ?? ''"),
      (t) => t.includes("<summary"),
      { label: "摘要骨架进预览" },
    );
    expect(txt).toContain("<summary turns=");
    // 「生成摘要」按钮出现（点击才花钱）
    expect(await ui.query<boolean>(`!!document.querySelector('[aria-label="生成摘要"]')`)).toBe(true);
    // 复位：取消勾选
    await ui.query<string>(
      `(() => { const cb=[...document.querySelectorAll('input[type=checkbox]')].find(c=>(c.closest('label')?.textContent||'').includes('计算历史摘要')); cb?.click(); return 'x'; })()`,
    );
    await expandAll();
  });

  it("头尾裁剪的「保留 前/后」输入就在头尾裁剪选项下面（不在只留调用+路径下面）", async () => {
    await ui.query<string>(
      `(() => { const r=[...document.querySelectorAll('input[type=radio]')].find(x=>x.parentElement.textContent.includes('头尾裁剪')); r?.click(); return 'x'; })()`,
    );
    const ys = await waitUntil(
      () =>
        ui.query<string>(
          `JSON.stringify({
             head: document.querySelector('input[aria-label="保留头部行数"]')?.getBoundingClientRect().y ?? null,
             htRadio: [...document.querySelectorAll('input[type=radio]')].find(x=>x.parentElement.textContent.includes('头尾裁剪'))?.getBoundingClientRect().y ?? null,
             callRadio: [...document.querySelectorAll('input[type=radio]')].find(x=>x.parentElement.textContent.includes('只留调用'))?.getBoundingClientRect().y ?? null,
           })`,
        ),
      (t) => t.includes('"head":') && !t.includes('"head":null'),
      { label: "头尾输入出现" },
    );
    const { head, htRadio, callRadio } = JSON.parse(ys) as { head: number; htRadio: number; callRadio: number };
    // 在头尾裁剪选项之下、且在「只留调用+路径」之上
    expect(head).toBeGreaterThan(htRadio);
    expect(head).toBeLessThan(callRadio);
    // 复位为原样
    await ui.query<string>(
      `(() => { const r=[...document.querySelectorAll('input[type=radio]')].find(x=>x.parentElement.textContent.includes('原样')); r?.click(); return 'x'; })()`,
    );
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
    // 默认展开到最大层级
    expect(cur).toBe(n);
    await ui.clickSelector('[aria-label="逐级展开"]');
    const label1 = await ui.query<string>(
      "document.querySelector('[aria-label=\"逐级展开\"]')?.textContent?.trim() ?? ''",
    );
    expect(label1).toBe(`展开 ${cur + 1 <= n ? cur + 1 : 0}/${n}`);
    // 每一档都要有实际变化（不能出现「点了没反应」的空档）：逐档遍历，可见行数应单调不减
    let prevVis = -1;
    for (let lv = 0; lv <= n; lv++) {
      const vis = await ui.query<number>(`document.querySelectorAll('[data-compact-preview] [data-diff]').length`);
      expect(vis).toBeGreaterThanOrEqual(prevVis);
      prevVis = vis;
      if (lv < n) await ui.clickSelector('[aria-label="逐级展开"]');
    }
    // 复位到最大层级
    await expandAll();
  });

  it("右栏渲染请求 YAML diff（含 system/messages 与增删行）", async () => {
    // YAML 结构（右栏）：base vs mod 的请求字段
    await expandAll();
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
