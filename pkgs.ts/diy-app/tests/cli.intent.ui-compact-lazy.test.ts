// tests/cli.intent.ui-compact-lazy.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##321：压缩预览**只在「窗口构成」抽屉真打开时才算**
//
// 现象（用户实测）：会话页之间切换卡 7~14s，全卡在 main。根因不是渲染 —— 是常挂组件
//   （`WindowRing` → `ContextPartsDrawer`，节点常驻、只由 `open` 控显隐）里那个预览
//   `createResource` 没有可见性门槛：打开任何会话页都立刻对整份 `ops.jsonl` 全量算一次
//   压缩预案（成本 ∝ 会话字节数，与"屏幕上显示多少"无关）；且 source 读的是挂载瞬间的
//   `store.currentUri`（还指着**上一个会话**）→ 从大会话切走时把同一份历史又算一遍。
//
// 怎么观测「main 到底算没算」：
//   渲染端拦不到 —— `window.transport` 是 contextBridge 冻结代理（实测 frozen+sealed、
//   `send` 不可写不可配置），包一层会被静默忽略（假绿陷阱）。
//   所以从**主进程入口**数：Electron 主进程的 RPC 全部经 `ipcMain.on('rpc')` 进来，
//   用 `NODE_OPTIONS=--require <hook>` 在主进程启动时把 `ipcMain.on` 包一层即可逐条记下
//   `{method, params}`。这条钩子只在本文件的实例里生效（NODE_OPTIONS 在 beforeAll 注入、
//   afterAll 还原），且 hook 内先判 `process.versions.electron`，CLI 子进程加载后直接空转。
//
// 断言结构（防假绿）：本文件先有一次**同方法的正向控制**（开抽屉 → 必须记到 1 条且 uri 对），
//   证明"方法名/钩子/取值路径"都对，随后的"零条"才有意义。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { basename, dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

const NL = String.fromCharCode(10);
/** 被观测的 RPC：压缩预览（"抽屉关着时 main 完全不出现 compactPreview" 就是它） */
const PREVIEW_METHOD = "diy.agent.local.compact.preview";

/**
 * 主进程探针（`NODE_OPTIONS=--require`）：把 `ipcMain.on('rpc')` 的入站信封逐条落到文件。
 * · 只记 `channel === 'rpc'`（其它 ipc 通道不是 RPC）；
 * · `process.versions.electron` 判据 = 只在本应用主进程干活（NODE_OPTIONS 会被 CLI 子进程继承，
 *   那些是纯 node，`require('electron')` 拿到的是路径字符串、`ipcMain` 不存在）；
 * · `require('electron')` 在 Electron 启动最早期还不可用 → 上界 1s 内重试（实测 ~25ms 内可取到）。
 */
const HOOK_SRC = `
const fs = require("fs");
const FILE = process.env.DIY_RPC_COUNT_FILE;
// ⚠️ 同一条 IPC 消息会被 **每个** listener 各收到一次（main 侧同一 channel 可能挂多个
//   binding），若在 wrap 里无条件 note，一条消息就被记 N 条 —— 会把"算了一次"读成"算了 N 次"。
//   实测本应用正是 N=2（所有方法都成对出现）。用 event 实例去重 = 每条消息恰好一条记录。
const seen = new WeakSet();
if (FILE && process.versions && process.versions.electron) {
  const note = (o) => { try { fs.appendFileSync(FILE, JSON.stringify(o) + "\\n"); } catch (_) {} };
  const patch = (ipcMain) => {
    if (!ipcMain || ipcMain.__diyRpcCount) return;
    ipcMain.__diyRpcCount = true;
    const origOn = ipcMain.on.bind(ipcMain);
    ipcMain.on = function (channel, listener) {
      if (channel !== "rpc") return origOn(channel, listener);
      return origOn(channel, function (event, payload) {
        try {
          if (event && !seen.has(event)) {
            seen.add(event);
            if (payload && payload.method) note({ m: payload.method, p: payload.params, ts: Date.now(), pid: process.pid });
          }
        } catch (_) {}
        return listener(event, payload);
      });
    };
    note({ m: "<patched>", p: null });
  };
  const tryPatch = (n) => {
    try { patch(require("electron").ipcMain); }
    catch (_) { if (n < 40) setTimeout(() => tryPatch(n + 1), 25); }
  };
  tryPatch(0);
}
`;

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uriA = "";
let uriB = "";
let hookDir = "";
let rpcLog = "";
let prevNodeOptions: string | undefined;
let prevCountFile: string | undefined;

beforeAll(async () => {
  // 探针必须在 **Electron 启动之前**注入环境（electron-test 用 ...process.env 起子进程）
  hookDir = mkdtempSync(join(tmpdir(), "diy-t321-rpc-hook-"));
  const hookPath = join(hookDir, "rpc-count.cjs");
  rpcLog = join(hookDir, "rpc.log");
  writeFileSync(hookPath, HOOK_SRC, "utf-8");
  prevNodeOptions = process.env["NODE_OPTIONS"];
  prevCountFile = process.env["DIY_RPC_COUNT_FILE"];
  process.env["NODE_OPTIONS"] = `${prevNodeOptions ?? ""} --require ${hookPath}`.trim();
  process.env["DIY_RPC_COUNT_FILE"] = rpcLog;

  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(electron.cdpUrl, async () => {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as any)?.data?.tree as A11yNode | undefined;
  });
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
  // 还原环境变量（同 worker 后续测试文件不该继承探针）+ 清临时目录
  if (prevNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
  else process.env["NODE_OPTIONS"] = prevNodeOptions;
  if (prevCountFile === undefined) delete process.env["DIY_RPC_COUNT_FILE"];
  else process.env["DIY_RPC_COUNT_FILE"] = prevCountFile;
  rmSync(hookDir, { recursive: true, force: true });
});

// ── 观测：主进程收到的 RPC 流水 ────────────────────────────────
const rpcLines = (): string[] => {
  try {
    return readFileSync(rpcLog, "utf-8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
};
/** 帧位（= 当前已记条数）；断言只看它之后的条目 */
const mark = (): number => rpcLines().length;
const callsSince = (from: number, method = PREVIEW_METHOD): { uri: string | null }[] =>
  rpcLines()
    .slice(from)
    .filter((l) => l.includes(method))
    .map((l) => ({ uri: (JSON.parse(l) as { p?: { input?: { taskUri?: string } } }).p?.input?.taskUri ?? null }));

/** 造一段会话（每轮一个可辨识文本 + 一条工具输出）—— 只验"算没算"，不追求大文件 */
function seedSession(uri: string, tag: string, turns = 6): void {
  const file = join(fx.HOME, sessionFileRel(uri, "ops"));
  mkdirSync(dirname(file), { recursive: true });
  const ops: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= turns; i++) {
    const tn = `t${tag}${100 + i}`;
    ops.push({ op: "start", id: tn, kind: "turn", meta: { model: "test" } });
    ops.push({ op: "start", id: `${tn}_u`, kind: "text", parent: tn, meta: { role: "user" } });
    ops.push({ op: "delta", id: `${tn}_u`, fields: { content: `【${tag}】第${i}轮问题` } });
    ops.push({ op: "stop", id: `${tn}_u` });
    ops.push({ op: "start", id: `${tn}_a`, kind: "text", parent: tn, meta: { role: "assistant" } });
    ops.push({ op: "delta", id: `${tn}_a`, fields: { content: `【${tag}】第${i}轮回复。` } });
    ops.push({ op: "stop", id: `${tn}_a` });
    ops.push({ op: "start", id: `${tn}_r`, kind: "tool", parent: tn, meta: { tool: "bash" } });
    ops.push({ op: "patch", id: `${tn}_r`, fields: { args: { command: "rg -n x" }, status: "done", title: "rg -n x" } });
    ops.push({ op: "delta", id: `${tn}_r`, fields: { output: Array.from({ length: 30 }, (_, k) => `row ${k}`).join(NL) } });
    ops.push({ op: "stop", id: `${tn}_r` });
    ops.push({ op: "stop", id: tn });
  }
  writeFileSync(file, ops.map((o) => JSON.stringify(o)).join(NL) + NL, "utf-8");
}

/** a11y 文本（判"会话上屏了"） */
async function a11yText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui inspect");
  const acc: string[] = [];
  const walk = (n: any) => {
    if (n?.text) acc.push(String(n.text));
    for (const c of n?.children ?? []) walk(c);
  };
  walk((res.data as any)?.data?.tree);
  return acc.join(NL);
}

/** 打开会话页并等它上屏（用该会话独有的文本作判据，避免"打开的是上一个"） */
async function openSession(uri: string, marker: string): Promise<void> {
  await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
  await waitUntil(a11yText, (t) => t.includes(marker), { label: `会话上屏 ${marker}` });
}

/** 点窗口占用环 → 开「窗口构成」抽屉（合成 click：hover 卡的 pointerenter 会盖住环） */
async function openDrawer(): Promise<void> {
  await ui.query<string>(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('窗口占用')); if(!b) return 'no'; b.click(); return 'ok'; })()`,
  );
  await waitUntil(a11yText, (t) => t.includes("窗口构成"), { label: "窗口构成抽屉打开" });
}

async function closeDrawer(): Promise<void> {
  await ui.clickSelector('[aria-label="关闭窗口构成"]');
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('input[aria-label="压缩预算KB"]')`),
    (v) => v === false,
    { label: "抽屉已关" },
  );
}

/** 让"没发生"的断言有落点：正事件（该发生的）已出现 + 静置一段，再断言"不该发生的没发生" */
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

describe("##321 压缩预览懒算：抽屉关着 = main 零成本", () => {
  it("setup: 两个会话各自落盘 + 主进程探针已生效", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/lazy --label 懒算`);
    const pid = String((p.data as any)?.data?.id);
    const a = await fx.sh.getJson(`./diy.sh task create "懒算 A" ${pid}`);
    const b = await fx.sh.getJson(`./diy.sh task create "懒算 B" ${pid}`);
    uriA = String((a.data as any)?.data?.uri);
    uriB = String((b.data as any)?.data?.uri);
    expect(uriA).toMatch(new RegExp("^projects/.+/tasks/.+$"));
    seedSession(uriA, "A");
    seedSession(uriB, "B");
    // 探针自检（**正向控制**，否则后面所有"零条"都是假绿）：hook 必须打过点，且渲染端 RPC
    // 必须真的被记下来 —— 触发手段 = 打开一个会话页（这必然产生若干 renderer→main 的 RPC）。
    await waitUntil(() => Promise.resolve(rpcLines()), (l) => l.some((x) => x.includes("<patched>")), {
      label: "主进程 RPC 探针生效",
    });
    await openSession(uriB, "【B】第6轮问题");
    const seen = await waitUntil(() => Promise.resolve(rpcLines()), (l) => l.some((x) => x.includes('"m":"diy.')), {
      label: "探针记到 renderer RPC",
    });
    expect(seen.some((l) => l.includes("<patched>"))).toBe(true);
    expect(seen.some((l) => l.includes('"m":"diy.'))).toBe(true);
  });

  it("打开会话页（抽屉关着）→ **一次 compactPreview 都不打**", async () => {
    const from = mark();
    await openSession(uriA, "【A】第6轮问题");
    await settle();
    expect(callsSince(from).map((c) => c.uri)).toEqual([]);
  });

  it("抽屉真打开 → 才算一次，且算的是**本页**的 uri（不是上一个会话、也不是两次）", async () => {
    const from = mark();
    await openDrawer();
    await waitUntil(() => Promise.resolve(callsSince(from).length), (n) => n >= 1, { label: "预览开算" });
    await settle(); // 等"第二发"（若有）现形
    expect(callsSince(from).map((c) => c.uri)).toEqual([uriA]);
    await closeDrawer();
  });

  it("抽屉关着切到别的会话 → 不重算（新页零成本）", async () => {
    const from = mark();
    await openSession(uriB, "【B】第6轮问题");
    await settle();
    expect(callsSince(from).map((c) => c.uri)).toEqual([]);
  });

  it("抽屉关着从 B 切回 A（大会话场景）→ **不再重算上一个会话**", async () => {
    let from = mark();
    await openSession(uriA, "【A】第6轮问题");
    await settle();
    expect(callsSince(from).map((c) => c.uri)).toEqual([]);
    // 反向再切一次：切页本身不该有任何压缩预览成本
    from = mark();
    await openSession(uriB, "【B】第6轮问题");
    await settle();
    expect(callsSince(from).map((c) => c.uri)).toEqual([]);
  });
});
