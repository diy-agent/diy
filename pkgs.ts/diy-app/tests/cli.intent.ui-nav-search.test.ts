// tests/cli.intent.ui-nav-search.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 nav ⌘K 快速打开会话的**行为**契约（真实 renderer + 真实输入事件）
//
// 需求（##254）：打开会话的路径过长（任务管理 → 搜索 → 点标题 → 点会话）。
// 期望：nav 有搜索入口，⌘K 唤起弹层，搜到即开会话。
//
// 契约：
//   1. nav 展开态有可见搜索入口；点击开弹层，输入框**自动聚焦**（开完就能打字）
//   2. ⌘K 开合弹层（当前空闲键位；全局只占了 ⌘F）
//   3. 搜到 → Enter 打开**该任务的会话 tab**（task-run:<uri>），不经过任务管理详情
//   4. ↑↓ 键盘导航：选中的那一条才被打开（不是永远第一条）
//   5. 已开着会话的任务标「已打开」（重复打开是聚焦，不新开）
//   6. Esc 关闭弹层且**不影响**当前 tab
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
import { lockNavOpen } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
/** 两个都命中 `navsearch` 的目标：晚期建的 updated 更新 → 排序在前 */
let uriLate = "";
let uriEarly = "";

const OVERLAY = '[data-testid="nav-search-overlay"]';
const INPUT = '[data-testid="nav-search-input"]';
const ITEM = '[data-testid="nav-search-item"]';

const overlayOpen = () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(OVERLAY)})`);
const items = () =>
  ui.query<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => e.textContent || "")`,
  );
const focusedIsInput = () =>
  ui.query<boolean>(`document.activeElement?.getAttribute("data-testid") === "nav-search-input"`);

async function tabs(): Promise<{ opened: string[]; active: string }> {
  const r = await fx.sh.getJson("./diy.sh ui tab list");
  return (r.data as any)?.data ?? { opened: [], active: "" };
}

/** 打开弹层并等到它真的上屏（CDP 输入是瞬时注入，缺这步会与下一拍竞态） */
async function openSearch(): Promise<void> {
  await ui.press("Meta+K");
  await waitUntil(overlayOpen, (v) => v, { label: "弹层打开" });
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
  const b = await fx.sh.getJson(`./diy.sh task create navsearch-晚期 ${pid}`);
  uriLate = String((b.data as any)?.data?.uri);
  expect(uriEarly).toMatch(/^projects\/.+\/tasks\/.+$/);
  expect(uriLate).toMatch(/^projects\/.+\/tasks\/.+$/);
}, 90000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

describe("nav ⌘K 快速打开会话", () => {
  it("nav 展开态有搜索入口；点击开弹层并自动聚焦输入框", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    await lockNavOpen(ui);
    await ui.clickSelector('[data-testid="nav-search-open"]');
    await waitUntil(overlayOpen, (v) => v, { label: "点击入口开弹层" });
    expect(await waitUntil(focusedIsInput, (v) => v, { label: "输入框自动聚焦" })).toBe(true);
    // 关闭，交给下一个用例从 ⌘K 路径进
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
  });

  it("⌘K 开合弹层", async () => {
    await openSearch();
    expect(await overlayOpen()).toBe(true);
    await ui.press("Meta+K");
    await waitUntil(overlayOpen, (v) => !v, { label: "⌘K 再按一次关闭" });
    expect(await overlayOpen()).toBe(false);
  });

  it("搜到任务 → Enter 打开该任务的会话 tab（不经过任务管理详情）", async () => {
    await openSearch();
    await ui.type("navsearch");
    // 结果里必须有两条（两个任务），并展示任务号 + 标题（能认出来是哪个）
    const list = await waitUntil(items, (v) => v.length >= 2, { label: "搜索结果出现" });
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.join("\n")).toContain("navsearch"); // 标题里带命中词
    expect(list.join("\n")).toMatch(/#\d+/); // 任务号

    await ui.press("Enter");
    // 弹层收起 + 目标任务的会话 tab 成为 active —— 这就是「打开会话」的界面事实
    expect(await waitUntil(overlayOpen, (v) => !v, { label: "Enter 后弹层收起" })).toBe(false);
    expect(await waitUntil(async () => (await tabs()).active, (k) => k === `task-run:${uriLate}`, {
      label: "打开了晚期那条的会话 tab",
    })).toBe(`task-run:${uriLate}`);
    // 「不经过任务管理详情」：不是 section 路由，而是 tab
    expect((await tabs()).opened).toContain(`task-run:${uriLate}`);
  });

  it("↑↓ 键盘导航：选中项才被打开", async () => {
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(items, (v) => v.length >= 2, { label: "搜索结果出现" });
    // 排序契约：同档按 updated 降序 → 晚期建的在前
    expect(list[0]).toContain("navsearch-晚期");
    expect(list[1]).toContain("navsearch-早期");

    await ui.press("ArrowDown"); // 选中第二条（早期）
    await ui.press("Enter");
    expect(await waitUntil(async () => (await tabs()).active, (k) => k === `task-run:${uriEarly}`, {
      label: "↓ 后打开的是第二条",
    })).toBe(`task-run:${uriEarly}`);
  });

  it("已开着会话的任务标「已打开」", async () => {
    await openSearch();
    await ui.type("navsearch");
    const list = await waitUntil(items, (v) => v.some((t) => t.includes("已打开")), {
      label: "「已打开」标记出现",
    });
    const early = list.find((t) => t.includes("navsearch-早期")) ?? "";
    expect(early).toContain("已打开");
  });

  it("Esc 关闭弹层，不影响当前 tab", async () => {
    const before = await tabs();
    await openSearch();
    await ui.press("Escape");
    await waitUntil(overlayOpen, (v) => !v, { label: "Esc 关弹层" });
    expect(await tabs()).toEqual(before);
  });
});
