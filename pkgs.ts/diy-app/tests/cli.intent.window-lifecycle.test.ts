// tests/cli.intent.window-lifecycle.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 窗口是视图，RPC 是常驻服务 —— 关掉窗口不能让 CLI 变哑巴
//
// 事故原文（任务 177 现场）：`./diy.sh` 报「致命错误: diy 管控台启动超时（30000ms）」，
// 而 main 进程明明还在跑。根因链：
//   1. 窗口被关（macOS 上 app 不退出）→ main 顺手 `rpcPort.stop()`
//   2. 进程仍**持有单实例锁**，但 RPC 端口已关 → CLI probe 失败
//   3. CLI 于是拉起新实例 → 被那把锁拒绝并退出 → 死等 30s 报超时
// 用户视角是「app 还在，CLI 却说启动不了」，且**没有任何窗口提示**。
//
// 契约：
//   1. 关窗后 CLI 仍连得上同一个实例（同 pid / 同端口），app.port 文件不变
//   2. 关窗后调界面 RPC（diy.ui.*）立即得到明确错误，而不是挂到超时
//      —— 转发目标必须被显式断开，「窗口不存在」是个可读的答案
//   3. 关窗后**再启动一次**（second-instance，真 spawn 第二个进程）→ 常驻实例把窗口请回来，
//      且 diy ui inspect 恢复可用（证明转发切到了新 webContents，不只看窗口存在会假绿）
//   4. 模拟点 Dock（activate）→ 同上（与 second-instance 共用 ensureWindow）
//
// 为什么 3/4 必须测：关窗常驻把「窗口回不来」从 bug 升级成**唯一正当性来源的缺失** ——
// 常驻的唯一收益是不打断正在跑的轮次，但窗口回不来时用户只能退出重开，收益归零。
//
// 关窗手法：renderer 里 `window.close()`（Electron 会把它转到 BrowserWindow.close()），
// 与真人点红叉走同一条路，而不是从 main 侧直接销毁窗口。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import electronPath from "electron";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
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
  ui = await makeUiDriver(electron.cdpUrl, async () => undefined);
}, 60000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

interface AppInfo {
  port: number;
  pid: number;
}

/** 窗口是否已经没了：CDP 的 page target 消失，或它的 url 变空（webContents 已销毁） */
async function windowGone(): Promise<boolean> {
  const port = new URL(fx.electron.cdpUrl!).port;
  const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
    r.json(),
  )) as { type: string; url: string }[];
  const page = list.find((t) => t.type === "page");
  return !page || page.url === "";
}

async function appInfo(timeoutMs = 10000): Promise<AppInfo> {
  // 显式给短超时：这条命令若挂在「启动超时 30s」路径上，用默认 20s 只会让用例更难读
  const r = await fx.sh.run("./diy.sh getAppInfo --json", timeoutMs);
  if (r.code !== 0) throw new Error(`getAppInfo 失败 exit=${r.code}\nstderr: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { data: AppInfo }).data;
}

describe("关掉窗口后 RPC 服务继续可用", () => {
  it("窗口关掉 → CLI 仍连同一实例（端口/PID 不变，app.port 不被改写）", async () => {
    const before = await appInfo();
    const portFile = join(fx.HOME, "app.port");

    // 关窗：真实路径（renderer 的 window.close → BrowserWindow.close → window-all-closed）。
    // 用 setTimeout 把 close 推后一拍：evaluate 的响应必须先发出去，否则页面一销毁
    // 这次 CDP 调用就永远等不到回包（实测会挂死用例）。
    await ui.eval("(() => { setTimeout(() => window.close(), 50); return true; })()");
    // 「窗口真的没了」的判据：page target 消失，或其 url 变空（webContents 已 destroyed）
    await waitUntil(windowGone, (gone) => gone, { label: "窗口已关闭" });

    const after = await appInfo();
    expect(after.pid).toBe(before.pid); // 没有另起实例（锁还在，别被锁拒后死等）
    expect(after.port).toBe(before.port); // RPC 端口没停
    expect(readFileSync(portFile, "utf-8").trim()).toBe(String(before.port));
  });

  it("窗口关掉后调界面 RPC → 明确报「窗口不存在」，不挂到超时", async () => {
    const r = await fx.sh.run("./diy.sh ui inspect", 10000);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("窗口不存在");
  });
});

// ── 关窗后「窗口回得来」：常驻唯一的正当性来源 ──
// 判据分两层，缺一假绿：
//   ① 窗口回来了（CDP page target 重新出现）
//   ② diy ui inspect 恢复可用 —— 证明 diy.ui.* 的转发真的切到了新 webContents
//   只测 ① 会漏掉「漏 setRendererTransport」那种半截修复（窗口在、界面 RPC 归死人）。
//
// 触发方式：spawn 第二个 electron（同 HOME）→ 它撞单实例锁 → 常驻实例收到
// **second-instance** → 走 ensureWindow() 重建。activate（点 Dock）与它**共用同一函数**，
// 故本组用例同时锁定两条路（正是 review 指出「补了一处漏一处」的地方）。
/** 重建后的窗口需要重新 attach（旧 ui 句柄指向已销毁的 webContents） */
async function freshUi(): Promise<void> {
  await waitUntil(windowGone, (gone) => !gone, { label: "窗口重新出现" });
  await waitUntil(
    async () => {
      const port = new URL(fx.electron.cdpUrl!).port;
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as {
        type: string;
        url: string;
      }[];
      return list.some((t) => t.type === "page" && t.url !== "");
    },
    (ok) => ok,
    { label: "page target 已加载（url 非空）" },
  );
  ui?.close();
  ui = await makeUiDriver(fx.electron.cdpUrl, async () => undefined);
}

/**
 * 真实 second-instance：同 HOME 再起一个 electron（撞锁即退，但常驻实例会收到事件）。
 *
 * ⚠️ 等 exit 不够：实测第二个进程 exit code:0 之后，常驻实例的事件还在路上 ——
 * 若立刻断言「窗口回来了」会假红（等 60s 都等不到，因为事件晚到且我们没等）。
 * 所以这里只负责「把事件发出去」，由调用方在 freshUi() 里轮询终态。
 * `out/main/index.mjs` 是 `startElectronTest` 的 cwd（appDir），与常驻实例同一份代码/同一 HOME。
 */
function spawnClash(): Promise<void> {
  return new Promise((resolve) => {
    const second = spawn(String(electronPath), ["out/main/index.mjs"], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, HOME: fx.HOME, DIY_HOME: fx.HOME, DIY_ENV: "test" },
      stdio: "ignore",
    });
    second.once("close", () => resolve());
  });
}

/** 界面 RPC 恢复（② 真判据）：diy ui inspect 拿得到无障碍树，而不是报「窗口不存在」 */
async function expectUiWorks(where: string): Promise<void> {
  const r = await fx.sh.run("./diy.sh ui inspect", 10000);
  expect(r.code, `${where}: diy ui inspect 应成功`).toBe(0);
  expect(r.stdout).not.toContain("窗口不存在");
}

/**
 * 幂等关窗：窗口已经没了就别再碰 CDP。
 *
 * ⚠️ 踩过的坑：`ui` 是 beforeAll 建的共享驱动，第一个用例关窗后它就指向**已销毁的 page target**；
 * 再对它 eval 时 socket 已断，而 Cdp.send 没有「无回包」处理 → promise 永不 settle →
 * 用例挂满 30s，且 spawnClash() 根本没执行（误表现为"second-instance 没送达"）。
 */
async function closeWindow(): Promise<void> {
  if (await windowGone()) return; // 已经关过 → 什么都不做
  const fresh = await makeUiDriver(fx.electron.cdpUrl, async () => undefined);
  try {
    await fresh.eval("(() => { setTimeout(() => window.close(), 50); return true; })()");
  } finally {
    fresh.close(); // 不留死驱动
  }
  await waitUntil(windowGone, (gone) => gone, { label: "窗口已关闭" });
}

describe("关窗后再启动一次（second-instance）→ 窗口请回来", () => {
  it("spawn 第二进程撞锁 → 常驻实例重建窗口，界面 RPC 恢复", async () => {
    await closeWindow();
    await spawnClash(); // 真实 second-instance 路径（同 activate 共用 ensureWindow）
    await freshUi();
    await expectUiWorks("second-instance 重建后");
  }, 30000);

  it("窗口缺席时再次撞锁 → 仍能重建（ensureWindow 幂等，覆盖 activate 同一条逻辑）", async () => {
    await closeWindow();
    await spawnClash();
    await freshUi();
    await expectUiWorks("再次重建后");
  }, 30000);
});
