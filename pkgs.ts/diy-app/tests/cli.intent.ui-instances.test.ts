// ═══════════════════════════════════════════════════════════════
// 🎯 导航「实例」页（##367）—— 真实 renderer + 真实第二个实例
//
// 需求原文（用户）：
//   > 是否能开发一个功能，可以列出所有当前的 diy 进程表格 …… 再加个「显示」按钮：
//   > 全屏并获取焦点，可以快速切过去？
//
// 契约（本文件锁死）：
//   1. 侧栏有「实例」项，icon 与任务（📋）/ 会话（🛰）**明显不同**，且**不挂任务状态角标**（##350 的教训）；
//   2. 同时开 2+ 实例 → 表里**全部**列出来，行上的数据根 / 端口与服务端自报一致；
//   3. **只读**：页内没有任何「杀 / 停」入口（生产实例绝不可杀）；
//   4. 自动刷新**页面不可见时停**，恢复可见后继续；刷新**不打断**用户当前操作（选中 / 展开保持）；
//   5. 点「显示」→ **应用内**二次确认（不是原生 confirm）→ 目标窗口真的全屏前置；
//   6. 唤起**失败必须看得见**（页面红条 + 错误 toast）—— 禁静默；
//   7. 实例关掉后，一个刷新周期内从表里消失（别的实例不受影响）。
//
// 怎么做到"确定性"（避免 flaky）：
//   · 失败路径**不靠竞态**：先点「显示」把二次确认弹窗**开着**（弹窗只认那一行快照），
//     再停掉目标实例，然后确认 —— focus 此时必然找不到它，错误路径 100% 走到；
//   · "不可见即停"用**改写 document.visibilityState + 派发事件**驱动（macOS 遮挡跟踪
//     太不可控），并读页面上的刷新计数（`data-instances-refresh-count`）验证"真的停了"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen } from "./nav-helper";
import { waitUntil } from "./wait";

let instA: ElectronTest; // 被测 UI（本文件所有 `ui.*` 命令都打给它）
let instB: ElectronTest; // 「显示」的目标实例
let sh: ShellTest;
let ui: UiDriver;
let pidA = 0;
let pidB = 0;

interface Row {
  pid: number;
  port: number | null;
  diyHome: string;
  variant: string;
  status: string;
  window: { visible: boolean; fullScreen: boolean; minimized: boolean } | null;
}

/** 服务端的真相（与页面同源：都走 instances.list） */
async function rowsOf(): Promise<Row[]> {
  const r = await sh.run("./diy.sh instances list --json", 40000);
  if (r.code !== 0) throw new Error(`instances list 失败 exit=${r.code}\nstderr: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { data: { rows: Row[] } }).data.rows;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 表里当前渲染的 pid 列表（DOM 真相，不是服务端真相） */
const domPids = (): Promise<number[]> =>
  ui.query<number[]>(
    `[...document.querySelectorAll("[data-instance-pid]")].map(el => Number(el.getAttribute("data-instance-pid")))`,
  );

const rowText = (pid: number): Promise<string> =>
  ui.query<string>(`document.querySelector('[data-instance-pid="${pid}"]')?.textContent ?? ""`);

/** 页面上的"已完成刷新次数"（判轮询是否真的停了，只看"数据没变"是看不出的） */
const refreshCount = (): Promise<number> =>
  ui.query<number>(
    `Number(document.querySelector("[data-instances-refresh-count]")?.getAttribute("data-instances-refresh-count") ?? -1)`,
  );

/**
 * 让被测窗口**真的在前台**：macOS 的窗口遮挡跟踪会把被完全遮住的窗口打成
 * `visibilityState = "hidden"`（见 ui-drive.bringToFront 的说明）—— 而本页**按设计**
 * 在不可见时停轮询，不先摆正前提就会把"设计行为"误判成"坏了"。
 */
async function ensureVisible(): Promise<void> {
  await ui.bringToFront();
  const state = await waitUntil(() => ui.query<string>("document.visibilityState"), (s) => s === "visible", {
    timeoutMs: 3000,
    label: "被测窗口可见",
  });
  expect(state, "被测窗口必须可见（不可见时本页按设计停轮询）").toBe("visible");
}

/**
 * 尽量把窗口摆到前台，但**不当作硬前提**。
 *
 * 为什么要这个"软"版本：macOS 的遮挡跟踪在本测试里不可控 —— 上一条用例把目标实例切成全屏后，
 * 被测窗口被完全遮住就成了 `hidden`，而 `Page.bringToFront` 未必把 OS 窗口真的提到最前。
 * 而"确认弹窗 + 唤起失败"这条链**不依赖轮询**（弹窗拿的是那一行的快照、错误来自 RPC），
 * 故这里只尽力而为；需要轮询的用例（首屏 / 消失）仍用 `ensureVisible` 硬断言。
 */
async function tryBringToFront(): Promise<string> {
  await ui.bringToFront().catch(() => undefined);
  return ui.query<string>("document.visibilityState");
}

/** 把元素滚进视口再点：表格可能比窗口宽，「显示」列在屏幕外时坐标点击会落空 */
async function clickInTable(selector: string): Promise<void> {
  const found = await ui.query<boolean>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); return true; })()`,
  );
  if (!found) throw new Error(`[ui-instances] 表格里找不到元素: ${selector}`);
  await sleep(150);
  await ui.clickSelector(selector);
}

beforeAll(async () => {
  instA = await startElectronTest();
  instB = await startElectronTest();
  sh = new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME: instA.home, DIY_HOME: instA.home } });
  // 本文件只用选择器点击 / DOM 读取（不按 a11y 文本找元素）→ 不需要 ui inspect 那棵树
  ui = await makeUiDriver(instA.cdpUrl, async () => undefined);
  for (let i = 0; i < 60; i++) {
    if (await ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`)) break;
    await sleep(200);
  }
  await ui.bringToFront();
  // 「两个实例都在盘里」是后续所有用例的前提：先等它成立（扫进程 + 注册表 + 活体自报都要走完）
  const rows = await waitUntil(
    () => rowsOf(),
    (rs) => rs.some((r) => r.port === instA.port) && rs.some((r) => r.port === instB.port),
    { timeoutMs: 40000, intervalMs: 400, label: "A/B 两个实例都进盘" },
  );
  pidA = rows.find((r) => r.port === instA.port)!.pid;
  pidB = rows.find((r) => r.port === instB.port)!.pid;
  await sh.getJson("./diy.sh ui page navigate instances");
}, 240000);

afterAll(async () => {
  ui?.close();
  await instA?.stop();
  await instB?.stop();
});

describe("导航「实例」项", () => {
  it("侧栏有「实例」，icon 与任务/会话明显不同，且不挂任务状态角标", async () => {
    await lockNavOpen(ui);
    const info = await ui.query<{ found: boolean; icon: string; label: string; badges: number }>(`(() => {
      const btn = document.querySelector('.drawer-side button[title="实例"]');
      if (!btn) return { found: false, icon: "", label: "", badges: -1 };
      const spans = [...btn.querySelectorAll("span")].map(s => s.textContent.trim());
      return { found: true, icon: spans[0] ?? "", label: spans[1] ?? "", badges: btn.querySelectorAll(".badge").length };
    })()`);
    expect(info.found, "侧栏应有「实例」项（title=实例）").toBe(true);
    expect(info.icon, "icon 必须换个符号（别用 📋/🛰 免得被当成任务/会话）").not.toBe("");
    expect(["📋", "🛰"]).not.toContain(info.icon);
    expect(info.label).toBe("实例");
    // 「不显示任务状态」：侧栏项上不许出现状态角标（##350：长得像任务会误导）
    expect(info.badges).toBe(0);
    expect(await ui.query<boolean>(`!!document.querySelector("[data-instances-page]")`)).toBe(true);
  });
});

describe("列表：同时开 2+ 实例时全部列出", () => {
  it("两个测试实例都上屏，且行上的数据根 / 端口与服务端自报一致", async () => {
    const pids = await waitUntil(() => domPids(), (ps) => ps.includes(pidA) && ps.includes(pidB), {
      timeoutMs: 20000,
      intervalMs: 300,
      label: "两个实例都进表",
    });
    expect(pids).toContain(pidA);
    expect(pids).toContain(pidB);
    const textA = await rowText(pidA);
    const textB = await rowText(pidB);
    // 数据根 / 端口取的是实例**自报**（不是扫描者的猜测）—— 与 CLI 同一份数据，故必然一致
    expect(textA).toContain(instA.home);
    expect(textB).toContain(instB.home);
    expect(textA).toContain(String(instA.port));
    expect(textB).toContain(String(instB.port));
    expect(textB).toContain("test"); // 变体列
    // 表头汇总（与 CLI 表格末行同一句话）
    expect(await ui.query<string>(`document.querySelector("[data-instances-summary]")?.textContent ?? ""`)).toContain("共");
  });

  it("只读：页内没有任何「杀 / 停」入口；每行的「显示」都写明理由", async () => {
    const bad = await ui.query<string[]>(`[...document.querySelectorAll("[data-instances-page] button")]
      .map(b => b.textContent.trim())
      .filter(t => /杀|停|kill|stop|终止|退出实例/i.test(t))`);
    expect(bad, "本页是只读的：不提供杀 / 停实例的入口（生产实例绝不可杀 —— guard）").toEqual([]);
    const tips = await ui.query<string[]>(
      `[...document.querySelectorAll("[data-instance-focus]")].map(b => b.getAttribute("title") ?? "")`,
    );
    expect(tips.length).toBeGreaterThanOrEqual(2);
    for (const t of tips) expect(t.trim().length, "「显示」按钮必须说明为什么能/不能唤起").toBeGreaterThan(4);
  });
});

describe("自动刷新", () => {
  it("选中 + 展开跨一次真实刷新保持（刷新不打断用户当前操作）", async () => {
    await ensureVisible();
    // 选中 B 那一行（点 PID 单元格 —— 行中段可能落在别的可点元素上）
    await clickInTable(`[data-instance-pid="${pidB}"] td:nth-child(2)`);
    expect(await ui.query<string>(`document.querySelector('[data-instance-pid="${pidB}"]')?.getAttribute("aria-selected")`)).toBe("true");
    await clickInTable(`[data-instance-expand="${pidB}"]`);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-instance-detail="${pidB}"]')`)).toBe(true);

    // 等**真的**又刷了一轮（计数前进），再看选中 / 展开是否还在
    const before = await refreshCount();
    expect(before).toBeGreaterThanOrEqual(1);
    const after = await waitUntil(() => refreshCount(), (n) => n > before, { timeoutMs: 15000, intervalMs: 200, label: "轮询又走了一轮" });
    expect(after).toBeGreaterThan(before);
    expect(await ui.query<string>(`document.querySelector('[data-instance-pid="${pidB}"]')?.getAttribute("aria-selected")`)).toBe("true");
    expect(await ui.query<boolean>(`!!document.querySelector('[data-instance-detail="${pidB}"]')`)).toBe(true);
  }, 90000);

  it("页面不可见 → 停轮询（角标上屏 + 计数不再前进）；恢复可见 → 继续", async () => {
    await ensureVisible();
    // 真实遮挡在 mac 上不可控，故直接改写 visibilityState 再派发事件（组件读的就是它）
    await ui.eval(`(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      return document.visibilityState;
    })()`);
    const badge = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector("[data-instances-paused]")`),
      (v) => v,
      { timeoutMs: 3000, intervalMs: 100, label: "暂停角标上屏" },
    );
    expect(badge, "不可见时必须给出可见反馈（否则用户以为刷新坏了）").toBe(true);

    // 等过一个完整周期（3s）+ 余量：这段时间里本该刷 1~2 次
    const frozen = await refreshCount();
    await sleep(4500);
    expect(await refreshCount(), "页面不可见时空转 = 白扫 ps + 白探测").toBe(frozen);

    // 恢复可见 → 下一个节拍立刻补一次
    await ui.eval(`(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
      return document.visibilityState;
    })()`);
    const resumed = await waitUntil(() => refreshCount(), (n) => n > frozen, { timeoutMs: 6000, intervalMs: 200, label: "恢复可见后继续刷新" });
    expect(resumed).toBeGreaterThan(frozen);
    expect(await ui.query<boolean>(`!!document.querySelector("[data-instances-paused]")`)).toBe(false);
  }, 90000);
});

describe("「显示」按钮：唤起目标窗口", () => {
  it("点「显示」→ 应用内二次确认 → 目标窗口真的全屏前置", async () => {
    await ensureVisible();
    await clickInTable(`[data-instance-focus="${pidB}"]`);
    // 应用内 ConfirmDialog（原生 window.confirm 会卡住整个渲染进程、自动化也点不到）
    const dialog = await waitUntil(() => ui.query<string>(`document.querySelector('[data-confirm-ok]')?.textContent ?? ""`), (t) => t.length > 0, {
      timeoutMs: 5000,
      intervalMs: 100,
      label: "应用内确认弹窗出现",
    });
    expect(dialog).toContain("前置");
    await ui.clickSelector("[data-confirm-ok]");
    // 目标实例自己 show + focus + 全屏（不是扫描者动别人的窗口）—— 真相由 B 自报
    const rows = await waitUntil(() => rowsOf(), (rs) => rs.find((r) => r.pid === pidB)?.window?.fullScreen === true, {
      timeoutMs: 20000,
      intervalMs: 400,
      label: "B 窗口进入全屏",
    });
    expect(rows.find((r) => r.pid === pidB)?.window).toMatchObject({ fullScreen: true });
    // 成功也要出声（页面上的 toast，不是静默）
    const toast = await ui.query<string>(`[...document.querySelectorAll('.toast [data-toast="success"]')].map(el => el.textContent).join("|")`);
    expect(toast).toContain(`已唤起 pid=${pidB}`);
  }, 120000);

  it("唤起失败必须看得见：目标退出后再确认 → 页面红条 + 错误 toast（禁静默）", async () => {
    // 只是尽力摆正（B 还全屏盖着，可能仍是 hidden —— 本用例不依赖轮询，见 tryBringToFront）
    await tryBringToFront();
    // 关键：先把确认弹窗**开着**（弹窗拿的是那一行的快照，不随后台刷新消失），
    // 再停掉目标实例 —— 于是这次唤起必然失败，且失败**确定会发生**（不需要赌时序）
    await clickInTable(`[data-instance-focus="${pidB}"]`);
    await waitUntil(() => ui.query<boolean>(`!!document.querySelector("[data-confirm-ok]")`), (v) => v, {
      timeoutMs: 5000,
      label: "确认弹窗已打开",
    });
    await instB.stop();
    await ui.clickSelector("[data-confirm-ok]");

    const toast = await waitUntil(
      () => ui.query<string>(`[...document.querySelectorAll('.toast [data-toast="error"]')].map(el => el.textContent).join("|")`),
      (t) => t.includes("唤起失败"),
      { timeoutMs: 20000, intervalMs: 200, label: "错误 toast 上屏" },
    );
    expect(toast).toContain("唤起失败");
    const banner = await ui.query<string>(`document.querySelector("[data-instance-error]")?.textContent ?? ""`);
    expect(banner).toContain(`唤起 pid=${pidB} 失败`);
    // 页面不该假装没事：失败原因留在屏上（不是一闪而过的 toast 就完事）
    expect(await ui.query<boolean>(`!!document.querySelector("[data-instance-error]")`)).toBe(true);
  }, 120000);
});

describe("实例退出后从表里消失", () => {
  it("B 已停 → 一个刷新周期内从表里消失；A 仍在", async () => {
    await ensureVisible(); // 前置：窗口可见才有轮询（见 ensureVisible）
    const pids = await waitUntil(() => domPids(), (ps) => !ps.includes(pidB), {
      timeoutMs: 20000,
      intervalMs: 300,
      label: "B 从表里消失",
    });
    expect(pids).not.toContain(pidB);
    expect(pids, "别把不是目标的实例一起清掉").toContain(pidA);
    // 服务端也不再报它（磁盘/进程两条都生效了）
    const rows = await rowsOf();
    expect(rows.some((r) => r.pid === pidB)).toBe(false);
  }, 60000);
});
