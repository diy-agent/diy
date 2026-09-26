// tests/cli.intent.ui-title.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 窗口标题 = 实例标识
//    `diy(<数据根>) [dev|test] <git 分支> :<端口> pid <PID>`
//
// 需求原文：「顺手给 app 标题增加当前 diy_home 目录：diy(~/.diy) 以区别不同实例」
//          「test 时全是 `~` 是错误的，应该显示它打开的具体目录；还要显示所测分支
//           （不然 /tmp/sdfsf 这种目录无法判断来源）+ 端口号 + PID」（任务 177）
//
// 契约：
//   1. `getAppInfo` 回出：数据根展示形式、运行环境、git 分支、端口、PID ——
//      renderer 拿不到真实家目录与 git，这两样只能 main 侧算
//   2. 隔离实例（测试/临时 HOME）的展示形式是**绝对路径**，不得缩成 `~`
//      （`~` 指的是被改写的 $HOME，不是用户家目录 —— 那正是「测试时全是 ~」的 bug）
//   3. renderer 的 document.title 是标识本身（不是静态的 "diy solid"），
//      且**与 main 算出的值同源同格式**（两侧调同一个纯函数）
//   4. main 真的把它设成了原生窗口标题（BrowserWindow.setTitle），并且端口就绪后**重设过一次**
//      —— 原生标题 CDP 读不到，故 main 侧落一行 `[diy] 窗口标题: …` 到 main.log 供断言
//      （见 src/main/index.ts 的 applyWindowTitle）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { waitUntil } from "./wait";
import { instanceTitle } from "../src/shared/instance-title";

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
  diyHome: string;
  diyHomeDisplay: string;
  env: string;
  branch: string;
  port: number;
  pid: number;
}

/** getAppInfo 的 data */
async function appInfo(): Promise<AppInfo> {
  const r = await fx.sh.getJson("./diy.sh getAppInfo");
  return (r as any).data; // 壳是 { ok, data }（单层）
}

describe("getAppInfo：数据根展示形式 + 环境 + 分支 + 端口 + PID", () => {
  it("隔离实例的数据根照实显示绝对路径，不缩成 `~`", async () => {
    const i = await appInfo();
    expect(i.diyHome).toBe(fx.HOME);
    // 隔离 HOME 就是 DIY_HOME → 用 $HOME 当缩写基准会得到 `~`（本 bug 的现场）；
    // 基准是真实家目录（getpwuid）时它只是个不在家目录下的绝对路径
    expect(i.diyHomeDisplay).toBe(fx.HOME);
    expect(i.diyHomeDisplay).not.toBe("~");
    expect(i.env).toBe("test"); // setup.ts 声明 DIY_ENV=test
  });

  it("回出运行代码所在 git 分支（/tmp 数据根靠它判断来源）", async () => {
    const i = await appInfo();
    expect(i.branch).toBeTruthy();
    expect(i.branch).not.toBe("HEAD"); // detached 会兜成 `<短 sha>(detached)`
  });

  it("回出真实端口与 PID（标题的 `:<port>` / `pid <PID>` 段来源）", async () => {
    const i = await appInfo();
    expect(i.port).toBeGreaterThan(0);
    expect(i.pid).toBeGreaterThan(0);
  });
});

describe("renderer 的 document.title = 实例标识", () => {
  it("标题 = 数据根 + [test] + 分支 + :端口 + pid PID", async () => {
    const info = await appInfo();
    const expected = instanceTitle({
      homeDisplay: info.diyHomeDisplay,
      env: info.env,
      branch: info.branch,
      port: info.port,
      pid: info.pid,
    });

    const title = await waitUntil(
      () => ui.eval<string>("document.title"),
      (t) => t.startsWith("diy("),
      { label: "标题由 renderer 设上" },
    );
    expect(title).toBe(expected);
    // 逐段确认（同源同格式之外，还要真的"内容够充分"）
    expect(title).toContain(info.diyHomeDisplay); // 具体目录，不是 `~`
    expect(title).toContain("[test]");
    expect(title).toContain(info.branch);
    expect(title).toContain(`:${info.port}`);
    expect(title).toContain(`pid ${info.pid}`);
    expect(title).not.toContain("diy solid");
  });

  it("main 侧设成了同一个标题，且带端口（证明端口就绪后重设过原生标题）", async () => {
    const info = await appInfo();
    const expected = instanceTitle({
      homeDisplay: info.diyHomeDisplay,
      env: info.env,
      branch: info.branch,
      port: info.port,
      pid: info.pid,
    });

    const logPath = join(fx.HOME, "log", "main.log");
    const log = await waitUntil(
      () => Promise.resolve(existsSync(logPath) ? readFileSync(logPath, "utf-8") : ""),
      (txt) => txt.includes(`[diy] 窗口标题: ${expected}`),
      { label: "main.log 里出现最终窗口标题" },
    );
    expect(log).toContain(`[diy] 窗口标题: ${expected}`);
    expect(log).toContain(`:${info.port}`); // 端口段真的进了原生标题
  });
});
