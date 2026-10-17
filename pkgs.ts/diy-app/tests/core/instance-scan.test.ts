// 实例发现的第一层：`ps` 输出 → 实例进程行（纯函数）。
//
// 为什么值得单测：实例没有索引（`app.port` 是「一个数据根一份」），发现只能靠扫进程；
// 而一台机器上同一实例有 4~5 个 Electron 进程（main / GPU / renderer / utility / crashpad）。
// 去重规则一旦错，表格会出现「幽灵实例」，唤起也会打错 pid。
// 样本全部来自**本机实测**（见任务 body 的实测记录），不是编的。
import { describe, expect, it } from "vitest";
import {
  classifyProcess,
  cmdlineSummary,
  instanceEntryOf,
  isHelperCommand,
  parsePsOutput,
  pickInstanceProcesses,
} from "../../src/main/core/instance-scan";

const ELECTRON = "/Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const REPO = "/Users/ccc/git/diy/diy/pkgs.ts/diy-app";

/** 本机实测样本（pid 保留原值，便于对照真实现场） */
const PS_SAMPLE = [
  "    1     0 /sbin/launchd",
  ` 2339     1 ${ELECTRON} ${REPO}/build/prod/main/index.mjs --remote-debugging-port=0`,
  ` 2368     1 /Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --no-rate-limit --database=/Users/ccc/.diy/log/crashes`,
  ` 2404  2339 /Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir=/Users/ccc/.diy/electron_user_data`,
  ` 2405  2339 /Users/ccc/git/diy/diy/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --user-data-dir=/Users/ccc/.diy/electron_user_data --app-path=${REPO}/build/prod/main`,
  ` 6650     1 node ${REPO}/build/prod/cli/index.js agent local chat projects/4/tasks/366`,
  ` 7777     1 node ${REPO}/build/preview/serve/index.mjs --port 18889`,
  ` 8888     1 npx tsx ${REPO}/src/serve/index.ts --port 18890`,
  "  117     1 /usr/libexec/logd",
].join("\n");

describe("parsePsOutput", () => {
  it("跳过表头与畸形行，解析 pid/ppid/command", () => {
    const procs = parsePsOutput(`  PID  PPID COMMAND\n${PS_SAMPLE}`);
    // 解析层不做分类：9 行全在（分类/去重是下一层的活）
    expect(procs.map((p) => p.pid)).toEqual([1, 2339, 2368, 2404, 2405, 6650, 7777, 8888, 117]);
    expect(procs[1]).toMatchObject({ pid: 2339, ppid: 1 });
  });

  it("空输入 / 纯表头 → 空表（第一次跑或 ps 不可用时不炸）", () => {
    expect(parsePsOutput("")).toEqual([]);
    expect(parsePsOutput("  PID  PPID COMMAND\n")).toEqual([]);
  });
});

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

  it("helper 显形：--type= 与 chrome_crashpad_handler", () => {
    expect(isHelperCommand("Electron Helper (Renderer) --type=renderer --app-path=x/build/prod/main")).toBe(true);
    expect(isHelperCommand("chrome_crashpad_handler --database=/x")).toBe(true);
    expect(isHelperCommand(`${ELECTRON} ${REPO}/build/prod/main/index.mjs`)).toBe(false);
  });
});

describe("pickInstanceProcesses：一台机器 N 个进程 → 一个实例一行", () => {
  it("只留 Electron 主进程，helper / crashpad / CLI / launchd / 源码入口全排除", () => {
    const rows = pickInstanceProcesses(parsePsOutput(PS_SAMPLE));
    expect(rows.map((r) => r.pid)).toEqual([2339, 7777]);
  });

  it("同一实例的多个进程只出一行（renderer 里也带 --app-path=…/main，不能另起一行）", () => {
    const rows = pickInstanceProcesses(parsePsOutput(PS_SAMPLE));
    expect(rows.filter((r) => r.pid === 2339)).toHaveLength(1);
    expect(rows.some((r) => r.pid === 2405)).toBe(false);
  });

  it("pid 重复（多次采样/合并输入）也只留一条", () => {
    const dup = `${REPO}/build/prod/main/index.mjs`;
    const text = ` 1 1 x\n 42 1 ${ELECTRON} ${dup}\n 42 1 ${ELECTRON} ${dup}`;
    expect(pickInstanceProcesses(parsePsOutput(text))).toHaveLength(1);
  });

  it("结果按 pid 升序（人读顺序稳定）", () => {
    const rows = pickInstanceProcesses(parsePsOutput(PS_SAMPLE));
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
