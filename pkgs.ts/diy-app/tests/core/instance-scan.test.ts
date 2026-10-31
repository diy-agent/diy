// 实例发现的第一层：进程行 → 实例（纯函数，OS 无关）。
//
// 为什么值得单测：实例没有索引（`app.port` 是「一个数据根一份」），发现只能靠扫进程；
// 而一台机器上同一实例有 4~5 个 Electron 进程（main / GPU / renderer / utility / crashpad）。
// 去重规则一旦错，表格会出现「幽灵实例」，唤起也会打错 pid。
// 样本全部来自**本机实测**（见任务 body 的实测记录），不是编的。
//
// `ps` 文本 → 进程行的解析在 `tests/os/posix/`（平台相关，单独集合）。
import { describe, expect, it } from "vitest";
import {
  classifyProcess,
  cmdlineSummary,
  instanceEntryOf,
  isHelperCommand,
  pickInstanceProcesses,
  type PsProcess,
} from "../../src/main/core/instance-scan";

const ELECTRON = "/Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const REPO = "/Users/ccc/git/diy/diy/pkgs.ts/diy-app";

/** 本机实测样本（pid 保留原值，便于对照真实现场） */
const PROCS: PsProcess[] = [
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
  { pid: 2339, ppid: 1, command: `${ELECTRON} ${REPO}/build/prod/main/index.mjs --remote-debugging-port=0` },
  {
    pid: 2368,
    ppid: 1,
    command: `/Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --no-rate-limit --database=/Users/ccc/.diy/log/crashes`,
  },
  {
    pid: 2404,
    ppid: 2339,
    command: `/Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir=/Users/ccc/.diy/electron_user_data`,
  },
  {
    pid: 2405,
    ppid: 2339,
    command: `/Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --user-data-dir=/Users/ccc/.diy/electron_user_data --app-path=${REPO}/build/prod/main`,
  },
  { pid: 6650, ppid: 1, command: `node ${REPO}/build/prod/cli/index.js agent local chat projects/4/tasks/366` },
  { pid: 7777, ppid: 1, command: `node ${REPO}/build/lab/serve/index.mjs --port 18889` },
  { pid: 8888, ppid: 1, command: `npx tsx ${REPO}/src/serve/index.ts --port 18890` },
  { pid: 117, ppid: 1, command: "/usr/libexec/logd" },
];

describe("分类：只认实例主进程", () => {
  it("Electron 主进程：入口 token = build/<variant>/main/index.mjs", () => {
    const hit = instanceEntryOf(`${ELECTRON} ${REPO}/build/prod/main/index.mjs --remote-debugging-port=0`);
    expect(hit).toEqual({ entry: `${REPO}/build/prod/main/index.mjs`, variant: "prod", kind: "electron" });
  });

  it("serve 与 test 变体也认（serve 无窗口，却同样是实例）", () => {
    expect(instanceEntryOf(`node ${REPO}/build/test/serve/index.mjs`)).toMatchObject({ kind: "serve", variant: "test" });
  });

  it("CLI 客户端不是实例（cli/index.js 不是 main|serve 入口）", () => {
    expect(instanceEntryOf(`node ${REPO}/build/prod/cli/index.js agent local chat x`)).toBeNull();
  });

  it("Windows 路径（反斜杠 / 引号）同样认：路径判据不假设分隔符", () => {
    expect(
      instanceEntryOf(
        `"C:\\repo\\node_modules\\electron\\dist\\electron.exe" "C:\\repo\\pkgs.ts\\diy-app\\build\\prod\\main\\index.mjs" --remote-debugging-port=0`,
      ),
    ).toEqual({
      entry: "C:/repo/pkgs.ts/diy-app/build/prod/main/index.mjs",
      variant: "prod",
      kind: "electron",
    });
  });

  it("helper 显形：--type= 与 chrome_crashpad_handler", () => {
    expect(isHelperCommand("Electron Helper (Renderer) --type=renderer --app-path=x/build/prod/main")).toBe(true);
    expect(isHelperCommand("chrome_crashpad_handler --database=/x")).toBe(true);
    expect(isHelperCommand(`${ELECTRON} ${REPO}/build/prod/main/index.mjs`)).toBe(false);
  });
});

describe("pickInstanceProcesses：一台机器 N 个进程 → 一个实例一行", () => {
  it("只留 Electron 主进程，helper / crashpad / CLI / launchd / 源码入口全排除", () => {
    const rows = pickInstanceProcesses(PROCS);
    expect(rows.map((r) => r.pid)).toEqual([2339, 7777]);
  });

  it("同一实例的多个进程只出一行（renderer 里也带 --app-path=…/main，不能另起一行）", () => {
    const rows = pickInstanceProcesses(PROCS);
    expect(rows.filter((r) => r.pid === 2339)).toHaveLength(1);
    expect(rows.some((r) => r.pid === 2405)).toBe(false);
  });

  it("pid 重复（多次采样/合并输入）也只留一条", () => {
    const dup = `${REPO}/build/prod/main/index.mjs`;
    const list = [
      { pid: 1, ppid: 1, command: "x" },
      { pid: 42, ppid: 1, command: `${ELECTRON} ${dup}` },
      { pid: 42, ppid: 1, command: `${ELECTRON} ${dup}` },
    ];
    expect(pickInstanceProcesses(list)).toHaveLength(1);
  });

  it("结果按 pid 升序（人读顺序稳定）", () => {
    const rows = pickInstanceProcesses(PROCS);
    expect([...rows].map((r) => r.pid)).toEqual([2339, 7777]);
  });

  it("classifyProcess 对非实例进程返回 null（不抛错）", () => {
    expect(classifyProcess({ pid: 1, ppid: 0, command: "/sbin/launchd" })).toBeNull();
  });
});

describe("cmdlineSummary", () => {
  it("短命令行原样，长的截断成「…」", () => {
    expect(cmdlineSummary("a b")).toBe("a b");
    const out = cmdlineSummary("/very/long ".repeat(30));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(72);
  });
});
