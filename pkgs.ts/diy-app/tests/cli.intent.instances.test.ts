// ═══════════════════════════════════════════════════════════════
// 🎯 实例大盘（##366）：本机有哪些 diy 实例在跑 —— 列出来，并能把它请到前台
//
// 需求原文（用户）：
//   > 现在有很多 app 运行，看 worktree 基本知道是干啥，但 main 的完全不知道是为啥开的
//   > 是否能列出所有当前的 diy 进程表格 …… 再加个「显示」按钮：全屏并获取焦点，快速切过去
//
// 契约（本文件锁死）：
//   1. `instances ls` 在多实例并存时**全部列出来**，每行能对上真数据根与变体；
//   2. 跨实例的真相是**自报**：`ls` 里 B 的数据根 = B 自己报的数据根（不是扫描者的猜测）；
//   3. 关掉一个实例 → 下次 `ls` 不再出现（退出清理 / pid 存活过滤，二者任一生效即可）；
//   4. `instances.focus` 对目标实例生效（窗口前置 + 全屏），失败路径有明确错误；
//   5. `instances list` 的结构化行与 `ls` 是同一份数据（UI 靠它，不解析表格文本）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

let instA: ElectronTest;
let instB: ElectronTest;
const shells: ShellTest[] = [];

/** cwd = 仓库根：`./diy.sh` 是 worktree 通用 CLI 客户端，连谁由 DIY_HOME 决定 */
function shellFor(home: string): ShellTest {
  const sh = new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME: home, DIY_HOME: home } });
  shells.push(sh);
  return sh;
}

interface Row {
  pid: number;
  diyHome: string;
  port: number | null;
  variant: string;
  env: string;
  status: string;
  source: string;
  sourceKind: string;
  window: { visible: boolean; fullScreen: boolean; minimized: boolean } | null;
}

async function rowsOf(sh: ShellTest): Promise<Row[]> {
  const r = await sh.run("./diy.sh instances list --json", 40000);
  if (r.code !== 0) throw new Error(`instances list 失败 exit=${r.code}\nstderr: ${r.stderr}`);
  // `--json` 的信封：`{ok, data: <RPC 返回值>}`，而 list 的返回值就是 `{rows}`
  return (JSON.parse(r.stdout) as { data: { rows: Row[] } }).data.rows;
}

/** 本实例自报的 pid（`ElectronTest` 只暴露 home/port，pid 问实例自己最可靠） */
async function pidOf(sh: ShellTest): Promise<number> {
  const r = await sh.run("./diy.sh getAppInfo --json", 30000);
  if (r.code !== 0) throw new Error(`getAppInfo 失败 exit=${r.code}\nstderr: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { data: { pid: number } }).data.pid;
}

beforeAll(async () => {
  instA = await startElectronTest();
  instB = await startElectronTest();
}, 180000);

afterAll(async () => {
  for (const sh of shells) sh.close();
  await instA?.stop();
  await instB?.stop();
});

describe("instances ls / list（发现 + 自报）", () => {
  it("两个实例并存 → 都列出来，且能对上各自**自报**的数据根与端口", async () => {
    const sh = shellFor(instA.home);
    const rows = await rowsOf(sh);
    const a = rows.find((r) => r.port === instA.port);
    const b = rows.find((r) => r.port === instB.port);
    expect(a, "A 实例应在列").toBeTruthy();
    expect(b, "B 实例应在列").toBeTruthy();
    expect(a!.diyHome).toBe(instA.home);
    expect(b!.diyHome).toBe(instB.home);
    // 变体 = test（意图测试跑 build/test 产物）；数据根是隔离临时目录 —— 都不该是空的
    expect(a!.variant).toBe("test");
    expect(a!.env).toBe("test");
    expect(a!.status).toBe("ready");
  });

  it("表格文本版（ls）与结构化（list）是同一份数据：行数与端口逐个对上", async () => {
    const sh = shellFor(instA.home);
    const rows = await rowsOf(sh);
    const r = await sh.run("./diy.sh instances ls", 40000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("共 ");
    for (const row of rows) {
      expect(r.stdout, `ls 表格里应有 pid=${row.pid} 那一行`).toContain(String(row.pid));
      if (row.port !== null) expect(r.stdout).toContain(String(row.port));
    }
  });

  it("自己那一行带「谁开的」：注册表自报的父进程链（不是事后追的）", async () => {
    const sh = shellFor(instA.home);
    const rows = await rowsOf(sh);
    const a = rows.find((r) => r.port === instA.port)!;
    expect(a.sourceKind).toBe("registry");
    expect(a.source.length).toBeGreaterThan(0);
    expect(a.source).not.toBe("来源未知");
  });

  it("实例自报的 pid 与 ls 行里的 pid 一致（行不是「猜」出来的）", async () => {
    const sh = shellFor(instA.home);
    const pid = await pidOf(sh);
    const rows = await rowsOf(sh);
    expect(rows.some((r) => r.pid === pid)).toBe(true);
  });
});

describe("instances focus（唤起）", () => {
  it("唤起 B：B 窗口前置并全屏（由 B 自己执行，不是扫描者动别人的窗口）", async () => {
    const shA = shellFor(instA.home);
    const pidB = await pidOf(shellFor(instB.home));
    const r = await shA.run(`./diy.sh instances focus --pid ${pidB} --json`, 40000);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { data: { via: string; pid: number } }).data).toMatchObject({ via: "rpc", pid: pidB });

    // 窗口状态由 B 自报 → 轮询等它真的进全屏（RPC 回来后再取一次状态）
    const rows = await waitUntil(
      () => rowsOf(shA),
      (rs) => rs.find((x) => x.pid === pidB)?.window?.fullScreen === true,
      { timeoutMs: 8000, intervalMs: 300, label: "B 窗口进入全屏" },
    );
    expect(rows.find((x) => x.pid === pidB)?.window).toMatchObject({ fullScreen: true });
  }, 90000);

  it("pid 不存在 → 明确报错并指路（不静默成功）", async () => {
    const r = await shellFor(instA.home).run("./diy.sh instances focus --pid 4194303", 40000);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/找不到实例 pid=4194303/);
  });

  it("既不给 --pid 也不给 --port → 用法错误，明确说清", async () => {
    const r = await shellFor(instA.home).run("./diy.sh instances focus", 40000);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--pid|--port/);
  });
});

describe("实例退出后不再出现在盘里", () => {
  it("stop B 后：ls 里不再有 B 的端口（pid 存活过滤 / 退出清理生效）", async () => {
    const shA = shellFor(instA.home);
    const portB = instB.port;
    await instB.stop();
    const rows = await waitUntil(
      () => rowsOf(shA),
      (rs) => !rs.some((x) => x.port === portB),
      { timeoutMs: 10000, intervalMs: 400, label: `B(port ${portB}) 从盘里消失` },
    );
    expect(rows.some((x) => x.port === portB)).toBe(false);
    // A 还在（别把不是目标的实例一起清掉）
    expect(rows.some((x) => x.port === instA.port)).toBe(true);
  }, 90000);
});
