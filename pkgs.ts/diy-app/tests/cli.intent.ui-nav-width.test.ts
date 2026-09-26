// tests/cli.intent.ui-nav-width.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 侧栏（导航）宽度契约：可拖调 + 持久化
//
// 需求原文：「nav 可调整宽度并记录持久化，当前任务列表很多字显示不出来，需要调整」
// 契约（用户能看见的行为）：
//   1. 展开宽度由**右缘手柄拖拽**决定，不再是写死的 14rem
//   2. 宽度落视图 cache（localStorage `diy_nav_width`）→ 重载后恢复
//   3. 越界拖动被 clamp 在 160-640；双击手柄复位默认 224
//
// 为什么用真实拖拽（CDP Input 域）而不是直接改 localStorage：前者证明手柄**真的
// 能抓住、宽度真的跟着鼠标走**；后者只能证明读取逻辑没写错（见 ui-drive 的分工）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen, navLocked } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

const SIDEBAR = `document.querySelector('.drawer-side .menu')`;
const GRIP = `.drawer-side [title^="拖动调整侧栏宽度"]`;

/** 侧栏当前渲染宽度（px） */
const navWidth = () => ui.query<number>(`${SIDEBAR}.getBoundingClientRect().width`);

/** 手柄中心点（拖拽起点） */
const gripCenter = () =>
  ui.query<{ x: number; y: number } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(GRIP)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);

/** 等 renderer 就绪（应用是异步挂载的，首条命令可能早于 DOM） */
async function waitAppReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await ui.query<boolean>(`!!${SIDEBAR}`)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("[nav-width] 等侧栏渲染超时");
}

/** 锁定展开（手柄只在展开态存在；收起态直接点 pin 点不响，见 nav-helper） */
async function pinOpen(): Promise<void> {
  await lockNavOpen(ui);
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
  await waitAppReady();
  await pinOpen();
}, 60000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

describe("侧栏宽度：可调 + 持久化", () => {
  it("默认 224px，拖右缘变宽并落盘 localStorage", async () => {
    // 前置：必须已**锁定**展开。只靠 hover 展开是不够的 —— 下面会把鼠标拖到侧栏之外
    // （那正是在拖宽度），鼠标一离开 hover 态就被 mouseleave 收拢成 rail。先断言这一点，
    // 免得「没锁上」表现为后面莫名其妙的宽度断言失败（曾把排查方向带偏）。
    expect(await navLocked(ui)).toBe(true);
    expect(await navWidth()).toBeCloseTo(224, 0);

    const grip = await gripCenter();
    expect(grip).not.toBeNull();
    await ui.drag(grip!, { x: 420, y: grip!.y }, 10);
    await new Promise((r) => setTimeout(r, 300));

    const w = await navWidth();
    expect(w).toBeGreaterThan(380);
    expect(await ui.query<string | null>(`localStorage.getItem('diy_nav_width')`)).toBe(String(Math.round(w)));
  });

  it("重载后恢复用户宽度（不是默认值）", async () => {
    const before = await navWidth();
    await ui.eval(`location.reload()`);
    await new Promise((r) => setTimeout(r, 2500));
    await waitAppReady();
    await pinOpen();
    expect(await navWidth()).toBeCloseTo(before, 0);
  });

  it("拖动越界被 clamp 在 160-640", async () => {
    const grip = await gripCenter();
    await ui.drag(grip!, { x: 2000, y: grip!.y }, 6);
    await new Promise((r) => setTimeout(r, 200));
    expect(await navWidth()).toBeLessThanOrEqual(640);

    const grip2 = await gripCenter();
    await ui.drag(grip2!, { x: 10, y: grip2!.y }, 6);
    await new Promise((r) => setTimeout(r, 200));
    expect(await navWidth()).toBeGreaterThanOrEqual(160);
  });

  it("双击手柄复位默认宽度", async () => {
    // 双击走 DOM 派发：ui-drive 目前只有 CDP 原生单击（clickCount=1），
    // 不足以合成 dblclick。命中性已由上面的 clickSelector/drag 覆盖。
    await ui.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(GRIP)});
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await navWidth()).toBeCloseTo(224, 0);
    expect(await ui.query<string | null>(`localStorage.getItem('diy_nav_width')`)).toBe("224");
  });
});
