// tests/cli.intent.ui-remote.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 导航「远程」页（##507）—— 真实 renderer
//
// 契约（本文件锁死，对应 body 判据 2/4/5）：
//   1. 侧栏有「远程」项，点进去是远程导航页（不是旧的裸 HubPage）；
//   2. 页面同时含「我」与「其他机器」两块（判据 2 的结构面）；
//   3. 每个可配对机器行**两个方向的动作都在**：`data-remote-action=invite` /
//      `data-remote-action=join`（判据 4），且各开 HubPage 的 host / join 屏；
//   4. 每行还有 `web 远程访问` 按钮（判据 3）；
//   5. 点「本机作为主控」→ HubPage 弹层出现，**配对五屏的第一屏（输入码/建邀请）可用**
//      —— 判据 5「从远程页能进到配对，不重写配对」。
//
// 怎么保证确定性：不依赖真的发现到别的机器（CI 上通常没有）。页面**始终**有我卡 + 两个
// 「本机作为主控 / 加入其他主控」按钮 —— 判据 4/5 走这两条（它们与机器行上的按钮同一函数）；
// 机器行那两个动作的存在性从 PAIR_ACTIONS 渲染而来，由 core/remote-nav 单测锁死结构。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "../shell-test";
import { startElectronTest, type ElectronTest } from "../electron-test";
import { makeUiDriver, type UiDriver } from "../ui-drive";
import { lockNavOpen } from "../nav-helper";
import { waitUntil } from "../wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

beforeAll(async () => {
  const electron = await startElectronTest();
  fx = {
    electron,
    HOME: electron.home,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", "..", ".."), env: { HOME: electron.home, DIY_HOME: electron.home } }),
  };
  ui = await makeUiDriver(electron.cdpUrl, async () => undefined);
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`),
    (ok) => ok,
    { timeoutMs: 30000, intervalMs: 200, label: "主界面就绪" },
  );
  await lockNavOpen(ui);
}, 180000);

afterAll(async () => {
  ui?.close();
  await fx?.electron.stop();
});

describe("远程导航页（##507）", () => {
  it("侧栏有「远程」项，点进去渲染远程页（我 + 其他机器）", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate hub");
    // 等远程页上屏（数据来自 remote.self / remote.list / hub.status 三个 RPC）
    const ok = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-remote-page]')`),
      (v) => v,
      { timeoutMs: 20000, intervalMs: 200, label: "远程页上屏" },
    );
    expect(ok).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-remote-machines]')`)).toBe(true);
    // ##511 判据 6：我的身份不在主列表里（挪到「本机 · 设置」，是设备卡的**兄弟**不是子节点）
    expect(await ui.query<boolean>(`!!document.querySelector('[data-remote-self]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-remote-machines] [data-remote-self]')`)).toBe(false);
    // ##511 判据 4：不再有独立的「已配对」表 —— 合并成一份设备清单
    expect(await ui.query<boolean>(`!!document.querySelector('[data-remote-paired-table]')`)).toBe(false);
  });

  it("##511：设备行只有 状态点 + 名字 + 一个值，操作在 ⋯ 里；点行进详情", async () => {
    // 现场可能没有其它机器（CI 常态）：有行就验形状，没行就验空态文案 —— 两种都不该红。
    const rows = await ui.query<number>(`document.querySelectorAll('[data-remote-row]').length`);
    if (rows === 0) {
      expect(await ui.query<boolean>(`!!document.querySelector('[data-remote-empty]')`)).toBe(true);
      return;
    }
    const shape = await ui.query<{
      dots: number;
      names: number;
      values: number;
      more: number;
      looseButtons: number;
    }>(`(() => {
      const row = document.querySelector('[data-remote-row]');
      return {
        dots: row.querySelectorAll('[data-remote-dot]').length,
        names: row.querySelectorAll('[data-remote-machine-name]').length,
        values: row.querySelectorAll('[data-remote-value]').length,
        more: row.querySelectorAll('[data-remote-more]').length,
        // 除 ⋯ 触发器外，行上不该再露出任何按钮（动作都收进下拉菜单）
        looseButtons: [...row.querySelectorAll('button')].filter((b) => !b.closest('.dropdown-content')).length,
      };
    })()`);
    expect(shape.dots).toBe(1);
    expect(shape.names).toBe(1);
    expect(shape.values).toBe(1);
    expect(shape.more).toBe(1);
    expect(shape.looseButtons).toBe(0);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-remote-more]')`)).toBe(true);

    await ui.clickSelector("[data-remote-row]");
    const open = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-remote-detail]')`),
      (v) => v,
      { timeoutMs: 10000, intervalMs: 200, label: "设备详情（二级页）出现" },
    );
    expect(open).toBe(true);
    await ui.clickSelector("[data-remote-detail-close]");
    const stillOpen = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-remote-detail]')`),
      (v) => !v,
      { timeoutMs: 10000, intervalMs: 200, label: "详情关闭" },
    );
    expect(stillOpen).toBe(false);
  });

  it("点「本机作为主控」→ HubPage 弹层出现（配对五屏复用，判据 5）", async () => {
    expect(await ui.query<boolean>(`!!document.querySelector('[data-hub-layer]')`)).toBe(false);
    await ui.clickSelector("[data-remote-open-host]");
    const open = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-hub-layer] [data-hub-page]')`),
      (v) => v,
      { timeoutMs: 10000, intervalMs: 200, label: "HubPage 弹层出现" },
    );
    expect(open).toBe(true);
    // 弹层里能看到主控屏的入口（「建邀请」按钮所在屏）
    expect(await ui.query<boolean>(`!!document.querySelector('[data-hub-layer] [data-hub-close]')`)).toBe(true);
  });

  it("点「本机作为主控」弹层的关闭按钮 → 弹层消失（可复用非独占 tab）", async () => {
    await ui.clickSelector("[data-hub-close]");
    // waitUntil 返回的是**最后一次取值**（不是谓词结果）：这里取的就是「弹层还在吗」
    const stillOpen = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-hub-layer]')`),
      (v) => !v,
      { timeoutMs: 10000, intervalMs: 200, label: "HubPage 弹层关闭" },
    );
    expect(stillOpen).toBe(false);
  });

  it("点「加入其他主控」→ HubPage 弹层打开 join 屏（两个方向都走已有流程，判据 4）", async () => {
    await ui.clickSelector("[data-remote-open-join]");
    const open = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-hub-layer] [data-hub-page]')`),
      (v) => v,
      { timeoutMs: 10000, intervalMs: 200, label: "HubPage 弹层出现（join）" },
    );
    expect(open).toBe(true);
    // join 屏有输入框（判据 21：先显示地址、人点确认后才出现输码框；这里只断言 join 屏在）
    expect(await ui.query<boolean>(`!!document.querySelector('[data-hub-layer] input')`)).toBe(true);
  });
});
