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
//   7. **IME 组合态**的 Enter / Esc 不被当成"确认/关闭"（中文拼音高频路径，review1 RV-1）
//   8. 命中超过展示上限时截断且给出「N / 共 M」提示（review1 RV-4）
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

const OVERLAY = '[data-testid="nav-search-overlay"]';
const INPUT = '[data-testid="nav-search-input"]';
const ITEM = '[data-testid="nav-search-item"]';

const overlayOpen = () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(OVERLAY)})`);
const items = () =>
  ui.query<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => e.textContent || "")`,
  );
const itemUris = () =>
  ui.query<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => e.dataset.uri || "")`,
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
  const pid = String((p.data as any)?.data?.id);
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
  expect(uriEarly).toMatch(/^projects\/.+\/tasks\/.+$/);
  expect(uriLate).toMatch(/^projects\/.+\/tasks\/.+$/);
  expect(uriMany).toHaveLength(NAV_SEARCH_LIMIT + 1);
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

  it("IME 组合态的 Enter / Esc 不被当成确认 / 关闭（RV-1 回归网）", async () => {
    await openSearch();
    await ui.type("navsearch");
    await waitUntil(items, (v) => v.length === 2, { label: "结果出现" });
    const before = await tabs();

    // 组合态 Enter：不该关弹层、不该打开任何会话（拼音"回车选词"不是"确认打开"）
    await ui.query(`(() => {
      document.querySelector('[data-testid="nav-search-input"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    expect(await overlayOpen()).toBe(true);
    expect(await tabs()).toEqual(before);

    // 组合态 Escape：不该关弹层（组合中的 Esc = 取消选词）
    await ui.query(`(() => {
      document.querySelector('[data-testid="nav-search-input"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    expect(await overlayOpen()).toBe(true);

    // 组合态结束后，正常 Enter 仍能打开（守"没把弹层打成永久不可用"）
    await ui.press("Enter");
    await waitUntil(overlayOpen, (v) => !v, { label: "正常 Enter 仍可关闭" });
  });

  it("Esc 关闭弹层，不影响当前 tab", async () => {
    const before = await tabs();
    await openSearch();
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
    expect(await tabs()).toEqual(before);
  });
});
