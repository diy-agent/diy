// tests/cli.intent.ui-title.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 窗口标题 = 实例标识（`diy(<数据根>)` + 非生产后缀）
//
// 需求原文：「顺手给 app 标题增加当前 diy_home 目录：diy(~/.diy) 以区别不同实例」
//
// 契约：
//   1. `getAppInfo` 回出数据根的展示形式（缩 `~`）与运行环境 —— renderer 拿不到
//      homedir，缩写只能 main 侧算
//   2. renderer 的 document.title 就是标识本身（不是静态的 "diy solid"），
//      且**与 main 算出的值同源同格式**（两侧调同一个纯函数）
//
// 为什么断言 document.title 而不是窗口标题：CDP 读不到原生窗口标题（那是 main 的
// BrowserWindow.title）。而 main 侧的值与 renderer 用的是同一个 instanceTitle()
// + 同一个 RPC 字段，规则本身由 tests/core/instance-title.test.ts 全覆盖。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
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

/** getAppInfo 的 data */
async function appInfo(): Promise<{ diyHome: string; diyHomeDisplay: string; env: string }> {
  const r = await fx.sh.getJson("./diy.sh getAppInfo");
  return (r as any).data; // 壳是 { ok, data }（单层）
}

describe("getAppInfo：数据根展示形式 + 运行环境", () => {
  it("回出 diyHomeDisplay 与 env（renderer 据此组装标题）", async () => {
    const i = await appInfo();
    expect(i.diyHome).toBe(fx.HOME);
    // 测试的隔离 HOME 就是 DIY_HOME → 缩成 `~`（main 侧 homedir() 读的也是这个 HOME）
    expect(i.diyHomeDisplay).toBe("~");
    expect(i.env).toBe("test"); // setup.ts 声明 DIY_ENV=test
  });
});

describe("renderer 的 document.title = 实例标识", () => {
  it("标题是 `diy(…) [test]`，不再是静态的 `diy solid`", async () => {
    const info = await appInfo();
    const expected = instanceTitle(info.diyHomeDisplay, info.env);

    const title = await waitUntil(
      () => ui.eval<string>("document.title"),
      (t) => t.startsWith("diy("),
      { label: "标题由 renderer 设上" },
    );
    expect(title).toBe(expected);
    expect(title).toBe("diy(~) [test]");
    expect(title).not.toContain("diy solid");
  });

  it("标题里带数据根：换个数据根的实例标题就不同（这正是「区分实例」）", () => {
    // 纯函数层面确认差异，不依赖再起一个实例
    expect(instanceTitle("~/.diy", "production")).not.toBe(instanceTitle("~", "test"));
  });
});
