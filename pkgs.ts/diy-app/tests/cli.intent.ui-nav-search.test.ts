// tests/cli.intent.ui-nav-search.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 nav ⌘K 快速打开会话的**行为**契约（真实 renderer + 真实输入事件）
//
// 需求（##254）：打开会话的路径过长（任务管理 → 搜索 → 点标题 → 点会话）。
// 期望：nav 有搜索入口，⌘K 唤起弹层，搜到即开会话。
//
// 契约：
//   1. nav 有可见入口 —— **展开态与收起态（rail）都要有**；点击开弹层并自动聚焦输入框
//   2. ⌘K 开合弹层（当前空闲键位；全局只占了 ⌘F）
//   3. 搜到 → Enter 打开**该任务的会话 tab**（task-run:<uri>），不经过任务管理详情
//   4. ↑↓ 键盘导航：选中的那一条才被打开（不是永远第一条）
//   5. 已开着会话的任务标「已打开」；对它 Enter = 只切 active，不新开、顺序不变
//   6. Esc 关闭弹层且**不影响**当前 tab
//   7. **IME 组合态**的 Enter / Esc 不被当成"确认/关闭"（中文拼音高频路径，review1 RV-1；
//      走真实 CDP `Input.imeSetComposition`，并断言该次 keydown 确实带 isComposing，防假绿）
//   8. 命中超过展示上限时截断且给出「N / 共 M」提示（review1 RV-4）
//   9. `Ctrl+K` 与 `⌘K` 等效（Windows/Linux 习惯；App 里两键同一分支）
//  10. 鼠标点击结果项即打开该会话（键盘不是唯一路径，review3 R3-5）
//  11. 点击遮罩空白处关闭弹层（onClick 路径，review3 R3-5）
//  12. `↑` 在首项回绕到末项（不是卡在第一条，review3 R3-5）
//  13. Esc 关弹层**不牵连**任务详情面板（review3 R3-1a：两条 window 级 Esc 互不相识）
//  14. 后台任务变更导致结果重排后，选中项仍跟着**同一条任务**（review4 R4-1：记 uri 不记下标）
//  15. 关闭弹层后焦点归还触发元素；0 命中时 Enter 无副作用（review4 R4-6）
//
// 为什么走真实 UI 而不是 CLI 调状态：本功能全是键盘与焦点行为（聚焦、↑↓、Enter），
// 状态机断言证明不了「按了键有没有反应」——那正是本功能唯一值得测的东西。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen, unlockNav, navWidth, NAV_RAIL_W, NAV_MENU_SEL } from "./nav-helper";
import { NAV_SEARCH_LIMIT } from "../src/shared/nav-search";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
/** 同一 search 词下的两个目标：晚期建的 updated 更新 → 排序在前（见 setup 的 1.1s 间隔） */
let uriLate = "";
let uriEarly = "";
/** 截断用例用的第 3 批任务（不同 search 词，避免污染上面的 2 条） */
const uriMany: string[] = [];
/** 项目 id（R4-1 用例要在测试中途新建任务触发重排） */
let pid = "";
/** R4-1 专用词（独立于 navsearch，避免给其它用例多出结果） */
let uriReorderEarly = "";
let uriReorderLate = "";

const OVERLAY = '[data-testid="nav-search-overlay"]';
const ITEM = '[data-testid="nav-search-item"]';
/** 任务详情面板（TaskDetailPanel 根节点自带 data-task-detail-panel） */
const DETAIL = "[data-task-detail-panel]";

const overlayOpen = () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(OVERLAY)})`);
const items = () =>
  ui.query<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => e.textContent || "")`,
  );
const itemUris = () =>
  ui.query<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => e.dataset.uri || "")`,
  );
const detailOpen = () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(DETAIL)})`);
/** 当前高亮项（aria-selected）的 uri —— R4-1 用：重排后它应指向同一条任务 */
const selectedUri = () =>
  ui.query<string | null>(
    `document.querySelector('[data-testid="nav-search-item"][aria-selected="true"]')?.dataset.uri ?? null`,
  );
const focusedIsInput = () =>
  ui.query<boolean>(`document.activeElement?.getAttribute("data-testid") === "nav-search-input"`);
/**
 * 底部计数条文本（R2-1）。
 *
 * ⚠️ 必须取 **`[data-testid="nav-search-footer"]`**，不能取 `OVERLAY.lastElementChild` ——
 * overlay 的唯一子元素是 panel，那样取到的是**整个面板文本**（含结果项的 `#12`），
 * 于是 `toContain("12")` 恒真、截断用例假绿。footer 节点已加 testid 定点。
 */
const footerText = () =>
  ui.query<string>(
    `document.querySelector('[data-testid="nav-search-footer"]')?.textContent || ""`,
  );

async function tabs(): Promise<{ opened: string[]; active: string }> {
  const r = await fx.sh.getJson("./diy.sh ui tab list");
  return (r.data as any)?.data ?? { opened: [], active: "" };
}

/** 打开弹层并等到它真的上屏（CDP 输入是瞬时注入，缺这步会与下一拍竞态） */
async function openSearch(): Promise<void> {
  await ui.press("Meta+K");
  await waitUntil(overlayOpen, (v) => v, { label: "弹层打开" });
}

/**
 * 通过 nav 的可见入口开弹层（真实点击）。收起态按钮位置随 hover 展开而变，
 * 故带重试（与 nav-helper 的 lockNavOpen 同款思路：要么到位、要么抛错）。
 */
async function openViaNavEntry(attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await ui.clickSelector('[data-testid="nav-search-open"]');
    if (await waitUntil(overlayOpen, (v) => v, { timeoutMs: 1500 })) return;
  }
  throw new Error("[nav-search] 点击 nav 搜索入口后弹层未打开");
}

/** 键盘选中某个 uri 的结果项：从 active=0 起按 ↓ 到它的下标（依赖列表顺序，见各用例前置断言） */
async function arrowDownTo(uri: string): Promise<void> {
  const list = await itemUris();
  const idx = list.indexOf(uri);
  if (idx < 0) throw new Error(`[nav-search] 结果里没有 ${uri}（现有 ${list.join(", ")}）`);
  for (let i = 0; i < idx; i++) await ui.press("ArrowDown");
}

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
    return (r.data as any)?.data?.tree;
  });
  for (let i = 0; i < 60; i++) {
    if (await ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/navsearch --label NavSearch`);
  pid = String((p.data as any)?.data?.id);
  const a = await fx.sh.getJson(`./diy.sh task create navsearch-早期 ${pid}`);
  uriEarly = String((a.data as any)?.data?.uri);
  // 刻意间隔 >1s：让两条 updated 明确分先后，排序断言不依赖"同毫秒退化的 num 兜底"
  await new Promise((r) => setTimeout(r, 1100));
  const b = await fx.sh.getJson(`./diy.sh task create navsearch-晚期 ${pid}`);
  uriLate = String((b.data as any)?.data?.uri);
  // 第 3 批：制造"命中数 > 展示上限"（search 词 navmany，与上面两条互不污染）
  for (let i = 1; i <= NAV_SEARCH_LIMIT + 1; i++) {
    const t = await fx.sh.getJson(`./diy.sh task create navmany-${String(i).padStart(2, "0")} ${pid}`);
    uriMany.push(String((t.data as any)?.data?.uri));
  }
  // R4-1 专用：两条同档（标题前缀）任务，updated 分先后 → 晚期在前
  const r1 = await fx.sh.getJson(`./diy.sh task create navreorder-早期 ${pid}`);
  uriReorderEarly = String((r1.data as any)?.data?.uri);
  await new Promise((r) => setTimeout(r, 1100));
  const r2 = await fx.sh.getJson(`./diy.sh task create navreorder-晚期 ${pid}`);
  uriReorderLate = String((r2.data as any)?.data?.uri);
  expect(uriEarly).toMatch(/^projects\/.+\/tasks\/.+$/);
  expect(uriLate).toMatch(/^projects\/.+\/tasks\/.+$/);
  expect(uriMany).toHaveLength(NAV_SEARCH_LIMIT + 1);
  expect(uriReorderEarly).toMatch(/^projects\/.+\/tasks\/.+$/);
  expect(uriReorderLate).toMatch(/^projects\/.+\/tasks\/.+$/);
}, 120000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

describe("nav ⌘K 快速打开会话", () => {
  it("展开态：点击 nav 搜索入口开弹层并自动聚焦输入框", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    await lockNavOpen(ui);
    await openViaNavEntry();
    expect(await waitUntil(focusedIsInput, (v) => v, { label: "输入框自动聚焦" })).toBe(true);
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });

  it("收起态（rail）：🔍 入口仍在且可用", async () => {
    await unlockNav(ui);
    // 关键：unlockNav 结束时鼠标**仍停在 nav 上**（hover 展开态），必须先移开让它收拢，
    // 否则测到的是展开宽度（实测踩到：断言拿到的按钮宽 200px）。
    await ui.leaveSelector(NAV_MENU_SEL);
    await waitUntil(() => navWidth(ui), (w) => w <= NAV_RAIL_W + 1, { label: "侧栏回到 rail" });
    // rail 里入口必须存在，且收缩成图标尺寸（<= rail 宽）
    expect(await ui.query<boolean>(`!!document.querySelector('[data-testid="nav-search-open"]')`)).toBe(true);
    const w = await waitUntil(
      () => ui.query<number>(`Math.round(document.querySelector('[data-testid="nav-search-open"]').getBoundingClientRect().width)`),
      (v) => v <= NAV_RAIL_W,
      { label: "rail 入口为图标尺寸", timeoutMs: 2000 },
    );
    expect(w).toBeLessThanOrEqual(NAV_RAIL_W);
    await openViaNavEntry();
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });

  it("⌘K 开合弹层", async () => {
    await openSearch();
    expect(await overlayOpen()).toBe(true);
    // RV-2：弹层是阻塞式模态，层级必须高于所有"偶然浮起"的层（peek 150 / tooltip 200）
    const z = await ui.query<number>(
      `parseInt(getComputedStyle(document.querySelector('[data-testid="nav-search-overlay"]')).zIndex, 10)`,
    );
    expect(z).toBeGreaterThan(200);
    await ui.press("Meta+K");
    await waitUntil(overlayOpen, (v) => !v, { label: "⌘K 再按一次关闭" });
    expect(await overlayOpen()).toBe(false);
  });

  it("搜到任务 → Enter 打开该任务的会话 tab（不经过任务管理详情）", async () => {
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(items, (v) => v.length >= 2, { label: "搜索结果出现" });
    expect(list.length).toBe(2);
    expect(list.join("\n")).toContain("navsearch"); // 标题里带命中词
    expect(list.join("\n")).toMatch(/#\d+/); // 任务号

    await ui.press("Enter");
    expect(await waitUntil(overlayOpen, (v) => !v, { label: "Enter 后弹层收起" })).toBe(false);
    expect(await waitUntil(async () => (await tabs()).active, (k) => k === `task-run:${uriLate}`, {
      label: "打开了第一条（晚期）的会话 tab",
    })).toBe(`task-run:${uriLate}`);
    expect((await tabs()).opened).toContain(`task-run:${uriLate}`);
  });

  it("↑↓ 键盘导航：选中项才被打开", async () => {
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(items, (v) => v.length === 2, { label: "结果出现" });
    // 排序契约：同档按 updated 降序 → 晚期建的在前（setup 已保证 updated 分先后）
    expect(list[0]).toContain("navsearch-晚期");
    expect(list[1]).toContain("navsearch-早期");

    await ui.press("ArrowDown"); // 选中第二条（早期）
    const marked = await ui.query<boolean>(
      `document.querySelector('[data-testid="nav-search-item"][data-index="1"]')?.getAttribute("aria-selected") === "true"`,
    );
    expect(marked).toBe(true);
    await ui.press("Enter");
    expect(await waitUntil(async () => (await tabs()).active, (k) => k === `task-run:${uriEarly}`, {
      label: "↓ 后打开的是第二条",
    })).toBe(`task-run:${uriEarly}`);
  });

  it("已开着会话的任务标「已打开」，对它 Enter = 只切 active、不新开、顺序不变", async () => {
    const before = await tabs();
    expect(before.active).toBe(`task-run:${uriEarly}`); // 上一用例留下的现场
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(items, (v) => v.some((t) => t.includes("已打开")), {
      label: "「已打开」标记出现",
    });
    expect(list.find((t) => t.includes("navsearch-早期"))).toContain("已打开");

    // 选中"已打开"的那条（早期），Enter
    await arrowDownTo(uriEarly);
    await ui.press("Enter");
    await waitUntil(overlayOpen, (v) => !v, { label: "Enter 后弹层收起" });
    const after = await tabs();
    expect(after.active).toBe(`task-run:${uriEarly}`);
    // 不新开、顺序也不变（数组按位置比较，数组相等即顺序相等）
    expect(after.opened).toEqual(before.opened);
  });

  it("命中超过展示上限：截断到上限并提示「N / 共 M」", async () => {
    await openSearch();
    await ui.type("navmany");
    const list = await waitUntil(items, (v) => v.length >= NAV_SEARCH_LIMIT, { label: "截断后的结果出现" });
    expect(list.length).toBe(NAV_SEARCH_LIMIT);
    const footer = await waitUntil(footerText, (t) => t.includes("共"), { label: "底部计数出现" });
    // 精确到完整片段（R2-1：取的是定点 footer 节点，不是整块面板 —— 否则 "#12" 会让
    // 只断言 "12" 的用例恒真。这里直接校验整段文案，同时证明「显示上限 / 总数」都对）。
    expect(footer).toContain(`显示 ${NAV_SEARCH_LIMIT} / 共 ${NAV_SEARCH_LIMIT + 1} 条`);
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });

  it("IME 组合态：真实输入法路径下 Enter / Esc 不被当成确认 / 关闭（RV-1 回归网）", async () => {
    await openSearch();
    await ui.type("navsearch");
    await waitUntil(items, (v) => v.length === 2, { label: "结果出现" });
    const before = await tabs();

    // 记下随后 keydown 的 isComposing。**不记就等于没测**：组合态若没真到位，
    // "回车没打开"也可能只是"没有结果可开"而侥幸通过。
    const arm = () =>
      ui.query(`(() => {
        window.__imeKey = null;
        document.addEventListener('keydown', (e) => {
          if (!window.__imeKey) window.__imeKey = { key: e.key, isComposing: e.isComposing };
        }, true);
        return true;
      })()`);
    const lastKey = () => ui.query<{ key: string; isComposing: boolean } | null>("window.__imeKey");

    // —— 组合态 Enter：真实输入法（CDP `Input.imeSetComposition`），`isComposing` 由 Chromium
    //    在 IME 管线里自己打标 —— 这跟"我们自己造一个 isComposing:true 的事件"不是一回事，
    //    后者只证明 handler 认字段，证明不了真实输入法送来的回车确实带这个标。
    //    拼音"回车选词"不是"确认打开"：不该关弹层、不该打开任何会话。
    await ui.imeCompose("nav");
    await arm();
    await ui.press("Enter");
    expect((await lastKey())?.isComposing, "组合态 Enter 必须真带 isComposing（否则本用例假绿）").toBe(true);
    expect(await overlayOpen()).toBe(true);
    expect(await tabs()).toEqual(before);

    // —— 组合态 Escape：不该关弹层（组合中的 Esc = 取消选词）。
    //    ⚠️ 必须**重新**进入组合态：上面那次 Enter 被 handler 放行（没有 preventDefault），
    //    输入法的默认行为已经把组合态提交掉了 —— 不复位的话这一下测的是"普通 Esc"（假绿）。
    await ui.imeCompose("nav");
    await arm();
    await ui.press("Escape");
    expect((await lastKey())?.isComposing, "组合态 Escape 必须真带 isComposing").toBe(true);
    expect(await overlayOpen()).toBe(true);

    // 收尾：点遮罩空白处关闭。用鼠标路径（不受组合态影响），同时让 input 失焦、组合态结束。
    const pt = await ui.query<{ x: number; y: number }>(`(() => {
      const p = document.querySelector('[data-testid="nav-search-panel"]').getBoundingClientRect();
      return { x: Math.round(p.left + p.width / 2), y: Math.max(2, Math.round(p.top / 2)) };
    })()`);
    await ui.clickPoint(pt);
    await waitUntil(overlayOpen, (v) => !v, { label: "组合态下点遮罩仍可关弹层" });

    // 组合态结束后，普通 Enter 仍能确认打开（守"没把键盘路径打成永久不可用"）
    await openSearch();
    await ui.type("navsearch");
    await waitUntil(items, (v) => v.length === 2, { label: "结果再次出现" });
    await ui.press("Enter");
    await waitUntil(overlayOpen, (v) => !v, { label: "正常 Enter 仍可确认打开" });
  });

  it("Esc 关闭弹层，不影响当前 tab", async () => {
    const before = await tabs();
    await openSearch();
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
    expect(await tabs()).toEqual(before);
  });

  it("Ctrl+K 与 ⌘K 等效（Win/Linux 习惯；按住不放的连发只响应首次）", async () => {
    await ui.press("Ctrl+K");
    await waitUntil(overlayOpen, (v) => v, { label: "Ctrl+K 打开弹层" });
    await ui.press("Ctrl+K");
    await waitUntil(overlayOpen, (v) => !v, { label: "Ctrl+K 再按关闭" });
  });

  it("鼠标点击结果项即打开该会话（onClick 路径）", async () => {
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(itemUris, (v) => v.length === 2, { label: "结果出现" });
    // 排序契约：同日 updated 降序 → 晚期（后建）在前
    expect(list[0]).toBe(uriLate);
    await ui.clickSelector(ITEM, { nth: 1 }); // 真实点击第二条（早期）
    await waitUntil(overlayOpen, (v) => !v, { label: "点击后弹层收起" });
    expect(
      await waitUntil(async () => (await tabs()).active, (k) => k === `task-run:${uriEarly}`, {
        label: "点开的正是被点的那条",
      }),
    ).toBe(`task-run:${uriEarly}`);
  });

  it("点击遮罩空白处关闭弹层", async () => {
    await openSearch();
    // 遮罩是全屏的，几何中心恰好落在居中的面板里（点下去命中的是面板）——
    // 只能取"面板上方的那片遮罩"，并断言命中测试真的落在遮罩上（否则测的是别的东西）。
    const pt = await ui.query<{ x: number; y: number }>(`(() => {
      const p = document.querySelector('[data-testid="nav-search-panel"]').getBoundingClientRect();
      return { x: Math.round(p.left + p.width / 2), y: Math.max(2, Math.round(p.top / 2)) };
    })()`);
    const onBackdrop = await ui.query<boolean>(
      `document.elementFromPoint(${pt.x}, ${pt.y})?.closest('[data-testid="nav-search-overlay"]') !== null`,
    );
    expect(onBackdrop, "取到的点必须在遮罩上（不然测的是别的元素）").toBe(true);
    await ui.clickPoint(pt);
    await waitUntil(overlayOpen, (v) => !v, { label: "点遮罩关弹层" });
  });

  it("↑ 在首项回绕到末项（不是卡在第一条）", async () => {
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(itemUris, (v) => v.length === 2, { label: "结果出现" });
    expect(list[0]).toBe(uriLate);
    const selectedIdx = () =>
      ui.query<number>(
        `Number(document.querySelector('[data-testid="nav-search-item"][aria-selected="true"]')?.dataset.index ?? -1)`,
      );
    expect(await selectedIdx()).toBe(0); // 打开即选中首项
    await ui.press("ArrowUp"); // 首项再 ↑ → 回绕到末项
    expect(await waitUntil(selectedIdx, (v) => v === 1, { label: "↑ 回绕到末项" })).toBe(1);
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });

  it("Esc 关弹层不牵连任务详情面板（R3-1a 回归）", async () => {
    // 前置：任务管理页点开某任务的详情面板（右锚定 .card）
    await fx.sh.getJson("./diy.sh ui page navigate task");
    // 选择器定点到该行（不要按文本找：nav 上也有同名项，会点错）。
    // 先等行渲染出来、再滚进可视区：任务树此时已有十几行，行若在视口外，
    // CDP 的真实点击坐标命中不到它（实测首触会落空，靠 retry 才过）。
    const rowSel = `tr[data-uri="${uriEarly}"]`;
    await waitUntil(() => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(rowSel)})`), (v) => v, {
      label: "任务行渲染出来",
    });
    // ⚠️ 行标题的点击是**切换**语义（`selectedUri === row.key ? null : key`）：前面的用例
    // 已把 uriEarly 选过（selectTask 的模块级信号还指着它），不先归零的话这一下是"收起"，
    // 面板反而不会出现（实测：首触必失败，靠 retry 才过 —— 那是掩盖，不是通过）。
    if (await detailOpen()) {
      await ui.press("Escape");
      await waitUntil(detailOpen, (v) => !v, { label: "先收起已开的详情面板" });
    }
    await ui.query(`document.querySelector(${JSON.stringify(rowSel + " .diy-link")}).scrollIntoView({ block: "center" })`);
    await ui.clickSelector(`${rowSel} .diy-link`);
    await waitUntil(detailOpen, (v) => v, { label: "任务详情面板上屏" });

    await openSearch();
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
    // 修复前：TaskDetailPanel 也在 window 冒泡听 Esc，一次 Esc 把面板一起清掉
    expect(await detailOpen(), "关弹层不该顺手清掉详情面板").toBe(true);

    // 再按一次才清面板 —— 顺带证明面板自己的 Esc 没被改坏
    await ui.press("Escape");
    await waitUntil(detailOpen, (v) => !v, { label: "再按 Esc 清详情面板" });
  });

  it("后台新增任务导致重排后，选中项仍跟着原条目（R4-1 回归）", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    await openSearch();
    await ui.type("navreorder");
    const list = await waitUntil(itemUris, (v) => v.length === 2, { label: "reorder 结果出现" });
    expect(list[0]).toBe(uriReorderLate); // 排序契约：updated 降序
    expect(list[1]).toBe(uriReorderEarly);

    await ui.press("ArrowDown"); // 选中 index=1（早期）
    expect(await selectedUri()).toBe(uriReorderEarly);

    // 新建一条同样命中 navreorder 的任务：updated 最新 → 排到首位 → 原 index1 会变成别的条目。
    // 选中若记下标就会指错（修复前：selectedUri 变成 uriReorderLate）；记 uri 则不动。
    await fx.sh.getJson(`./diy.sh task create navreorder-最晚 ${pid}`);
    await waitUntil(itemUris, (v) => v.length === 3, { label: "后台任务变更后列表重排" });
    expect((await itemUris())[0]).not.toBe(uriReorderLate); // 证明真的重排了（否则本用例可能空过）
    expect(await selectedUri(), "重排后选中项应仍是用户当初选的那条").toBe(uriReorderEarly);

    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });

  it("关闭弹层后焦点归还触发元素（R4-6）", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    await lockNavOpen(ui);
    await openViaNavEntry();
    await waitUntil(focusedIsInput, (v) => v, { label: "输入框自动聚焦" });
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
    // 打开前是 nav 入口按钮 → 关闭后焦点该回到它（模态不该把焦点吞掉）
    const back = await waitUntil(
      () => ui.query<string | null>(`document.activeElement?.getAttribute("data-testid") ?? null`),
      (v) => v === "nav-search-open",
      { label: "焦点归还 nav 入口按钮", timeoutMs: 2000 },
    );
    expect(back).toBe("nav-search-open");
  });

  it("0 命中时 Enter 无副作用（R4-6）", async () => {
    const before = await tabs();
    await openSearch();
    await ui.type("zzz-绝无此任务-zzz");
    await waitUntil(
      () => ui.query<string>(`document.querySelector('[data-testid="nav-search-list"]')?.textContent || ""`),
      (t) => t.includes("没有匹配的任务"),
      { label: "空结果占位出现" },
    );
    await ui.press("Enter");
    expect(await overlayOpen(), "空结果时 Enter 不该关弹层").toBe(true);
    expect(await tabs(), "空结果时 Enter 不该打开任何会话").toEqual(before);
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });
});
