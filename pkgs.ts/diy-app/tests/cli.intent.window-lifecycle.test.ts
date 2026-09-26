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
//
// 关窗手法：renderer 里 `window.close()`（Electron 会把它转到 BrowserWindow.close()），
// 与真人点红叉走同一条路，而不是从 main 侧直接销毁窗口。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
