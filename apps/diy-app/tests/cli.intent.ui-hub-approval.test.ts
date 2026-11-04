// tests/cli.intent.ui-hub-approval.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 全局配对审批弹窗（##500 续）—— 真实 renderer
//
// 判据（本文件锁死 25/26 的界面面）：
//   1. **任何页面**收到 pending 请求都弹（不依赖路由：默认任务页 + 切到「会话」页仍在）；
//   2. 弹窗内容 = 设备名 + nodeId + 时间，且同意 / 拒绝两个动作都在；
//   3. 请求消失（别处已处理）→ 弹窗自动收起 —— 数据源是 `hub.pending`，不是本地状态。
//
// 怎么造请求而不起 Hub 服务：直接把一条 pending 写进临时 HOME 的 `hub/peers.json`
// （`hub.pending` 只读文件，3s 轮询会捡到）。这样测试不碰钥匙串、不碰 TLS、不碰网络。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen } from "./nav-helper";
import { waitUntil } from "./wait";

let electron: ElectronTest;
let ui: UiDriver;

const REQUEST_ID = "req_ui_approval_1";
const NODE_ID = "diy-sattest01";
const DISPLAY_NAME = "c-vn7";

function writePeers(home: string, requests: unknown[]): void {
  const dir = join(home, "hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "peers.json"),
    JSON.stringify(
      {
        version: 1,
        domainId: "default",
        hubNodeId: "diy-hubtest01",
        invitations: [],
        requests,
        memberships: [],
      },
      null,
      2,
    ),
  );
}

const pendingRow = {
  requestId: REQUEST_ID,
  domainId: "default",
  inviteId: "inv_test",
  nodeId: NODE_ID,
  displayName: DISPLAY_NAME,
  publicKey: "test-key",
  status: "pending",
  requestedAt: "2026-11-02T14:22:59.935+0800",
};

beforeAll(async () => {
  electron = await startElectronTest();
  ui = await makeUiDriver(electron.cdpUrl, async () => undefined);
  const ready = await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`),
    (ok) => ok,
    { timeoutMs: 20000, label: '等渲染器就绪（侧栏出现）' },
  );
  expect(ready).toBe(true);
  await lockNavOpen(ui);
  // 应用起来之后再写：轮询会在 3s 内捡到（顺序无关，先起后写同样测得到）
  writePeers(electron.home, [pendingRow]);
});

afterAll(async () => {
  await electron?.stop();
});

describe("全局审批弹窗", () => {
  it("默认任务页上就弹，内容与动作齐全（判据 25）", async () => {
    const appeared = await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-hub-approval]')`),
      (ok) => ok,
      { timeoutMs: 15000, label: '等全局审批弹窗出现' },
    );
    expect(appeared).toBe(true);

    const title = await ui.query<string>(`document.querySelector('[data-hub-approval-title]')?.textContent ?? ''`);
    expect(title).toContain(DISPLAY_NAME);
    expect(title).toContain("请求加入");

    const text = await ui.query<string>(`document.querySelector('[data-hub-approval]')?.textContent ?? ''`);
    expect(text).toContain(NODE_ID);
    expect(text).toContain("14:22:59");
    expect(text).toContain("1 个设备请求加入");

    const actions = await ui.query<string[]>(
      `[...document.querySelectorAll('[data-hub-approval] [data-hub-approval-action]')].map((e) => e.getAttribute('data-hub-approval-action'))`,
    );
    expect(actions.sort()).toEqual(["approve", "reject"]);
  });

  it("切到别的页面仍在（弹窗在 App 根，不在页面内）", async () => {
    const clicked = await ui.query<boolean>(`(() => {
      const btns = [...document.querySelectorAll('.drawer-side .menu button')];
      const target = btns.find((b) => (b.textContent ?? '').includes('会话'));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    expect(clicked).toBe(true);

    // 等主区切过去，再确认弹窗还在
    const stillThere = await waitUntil(
      () => ui.query<boolean>(`document.querySelector('[data-hub-approval-row="${REQUEST_ID}"]') !== null`),
      (ok) => ok,
      { timeoutMs: 5000, label: '切页后弹窗仍在' },
    );
    expect(stillThere).toBe(true);
  });

  it("请求消失后弹窗自动收起", async () => {
    writePeers(electron.home, []);
    const gone = await waitUntil(
      () => ui.query<boolean>(`document.querySelector('[data-hub-approval]') === null`),
      (ok) => ok,
      { timeoutMs: 15000, label: '等弹窗随请求消失而收起' },
    );
    expect(gone).toBe(true);
  });
});
