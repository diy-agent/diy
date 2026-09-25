// tests/cli.intent.ui-nav-viewbar.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 侧栏（导航）顶部 viewbar 契约：高度统一 + 按钮区在右
//
// 需求原文：「nav 上面那个 bar 区有点高，请统一的紧凑一些，应该和面包屑菜单那个
//             bar 一样高度」「pin 在 nav 下方一个按钮，把它移动到上面的 viewbar 区域」
//
// 契约：
//   1. nav 顶栏高度 = 面包屑栏高度（同一条水平带的控件必须同高，见 lib/layout-metrics）
//   2. pin（锁定/取消锁定）在顶栏右侧按钮区，nav 底部**不再有**第二套按钮行
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen } from "./nav-helper";
import { waitUntil } from "./wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

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
}, 60000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

/** 锁定展开（收起态 40px rail 没有按钮区，须先 hover 展开再点 pin，见 nav-helper） */
async function pinOpen(): Promise<void> {
  await lockNavOpen(ui);
}

describe("nav 顶栏：与面包屑同高 + pin 在顶栏", () => {
  it("顶栏高度 = 面包屑栏高度（32px，VIEW_BAR_H）", async () => {
    await pinOpen();
    const m = await ui.query<{ navBar: number; breadcrumb: number }>(`(() => {
      const bar = document.querySelector('.drawer-side .menu').firstElementChild;
      const crumb = document.querySelector('main > nav');
      return {
        navBar: Math.round(bar.getBoundingClientRect().height),
        breadcrumb: Math.round(crumb.getBoundingClientRect().height),
      };
    })()`);
    expect(m.navBar).toBe(32);
    expect(m.breadcrumb).toBe(32);
    expect(m.navBar).toBe(m.breadcrumb);
  });

  it("pin 在顶栏内，且 nav 底部没有第二套按钮行", async () => {
    const r = await ui.query<{ pinInBar: boolean; pinCount: number; barsInNav: number }>(`(() => {
      const menu = document.querySelector('.drawer-side .menu');
      const bar = menu.firstElementChild;
      const btn = document.querySelector('.drawer-side button[title*="锁定"]');
      // nav 内部的「bar」= 有 border-b 的直接子 div；应恰好 1 个（顶栏）
      const bars = [...menu.children].filter(el => el.tagName === 'DIV' && getComputedStyle(el).borderBottomWidth !== '0px');
      return {
        pinInBar: !!btn && bar.contains(btn),
        pinCount: document.querySelectorAll('.drawer-side button[title*="锁定"]').length,
        barsInNav: bars.length,
      };
    })()`);
    expect(r.pinInBar).toBe(true);
    expect(r.pinCount).toBe(1);
    expect(r.barsInNav).toBe(1);
  });

  it("点顶栏的 pin → 锁定态可切换（按钮标题随之变）", async () => {
    // 此时已锁定：点一次取消 → 变「锁定展开」；再点一次 → 变回「取消锁定」
    await ui.clickSelector('button[title*="取消锁定"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('.drawer-side button[title="锁定展开"]')`),
      (v) => v,
      { label: "取消锁定生效" },
    );
    // 取消后是 hover 展开态：鼠标还在侧栏上（DOM 层），按钮区仍在
    await ui.clickSelector('button[title="锁定展开"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('.drawer-side button[title*="取消锁定"]')`),
      (v) => v,
      { label: "重新锁定" },
    );
  });
});
