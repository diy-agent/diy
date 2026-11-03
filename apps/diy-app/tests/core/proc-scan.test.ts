// ##408 刀 10：`nohup xxx &` 起的进程也要被管理器看见 —— 判据在这里钉死（OS 无关）。
//
// 关键坑（写在测试名里）：`bash -c "nohup cmd &"` 退出后，`cmd` 被 reparent 到 init/launchd
// （ppid=1），按父子关系扫会漏——只能按**进程组**认领。
//
// 解析 `ps` 文本的测试在 `tests/os/posix/`（平台相关，单独集合）。
import { describe, expect, it } from "vitest";
import {
  childrenOfRun,
  isAppHelperProc,
  selectOwnedProcs,
  type GroupOwner,
  type PsRow,
} from "../../src/shared/proc-scan";

/** 一条归一化进程行（策略层产物；测试里直接构造，不再经过 ps 文本）。 */
const line = (pid: number, ppid: number, pgid: number, command: string, createdAt?: number): PsRow => ({
  pid,
  ppid,
  pgid,
  command,
  etimeText: "00:12",
  pcpu: 0,
  rssKb: 1024,
  ...(createdAt === undefined ? {} : { createdAt }),
});

const rows = (...list: PsRow[]): PsRow[] => list;

describe("isAppHelperProc — 不把 Electron 自己的渲染进程当成 agent 的活", () => {
  it("Chromium 子进程（--type=）与 Crashpad 都算 helper", () => {
    expect(isAppHelperProc(".../Electron Helper (Renderer) --type=renderer --foo")).toBe(true);
    expect(isAppHelperProc(".../Electron Helper --type=gpu-process")).toBe(true);
    expect(isAppHelperProc("/Applications/X.app/Contents/Frameworks/crashpad_handler --no-rate-limit")).toBe(true);
  });

  it("普通命令（bash / node / python）不是 helper", () => {
    expect(isAppHelperProc("/bin/bash -c sleep 30")).toBe(false);
    expect(isAppHelperProc("node server.js")).toBe(false);
    expect(isAppHelperProc("python3 -m http.server 8000")).toBe(false);
  });
});

describe("selectOwnedProcs — 认领判据（组号 ∪ 子孙）", () => {
  const groups = new Map<number, GroupOwner>([
    [120, { at: 1000, command: "nohup server &", cwd: "/tmp" }],
  ]);

  it("孤儿按**进程组**认领（ppid=1 也不漏）—— 这就是 `nohup xxx &` 那类", () => {
    const procs = selectOwnedProcs(rows(line(121, 1, 120, "node server.js")), {
      selfPid: 100,
      groups,
      runPids: new Map(),
    });
    expect(procs.map((p) => p.pid)).toEqual([121]);
    expect(procs[0]!.runId).toBeNull();
  });

  it("不是我们的组、也不是子孙 ⇒ 不认领（别人的进程一律不显示）", () => {
    const procs = selectOwnedProcs(rows(line(900, 1, 900, "node other.js")), {
      selfPid: 100,
      groups,
      runPids: new Map(),
    });
    expect(procs).toEqual([]);
  });

  it("没走 detached 的漏网也能抓：祖先链走到 app 主进程", () => {
    const all = rows(line(100, 1, 100, "Electron ."), line(200, 100, 100, "/bin/bash -c x"), line(201, 200, 100, "sleep 9"));
    const procs = selectOwnedProcs(all, { selfPid: 100, groups: new Map(), runPids: new Map() });
    expect(procs.map((p) => p.pid)).toEqual([200, 201]);
  });

  it("app 自己（selfPid）永不进表", () => {
    const all = rows(line(100, 1, 100, "Electron ."), line(200, 100, 100, "/bin/bash -c x"));
    expect(selectOwnedProcs(all, { selfPid: 100, groups: new Map(), runPids: new Map() }).some((p) => p.pid === 100)).toBe(false);
  });

  it("Electron helper 被排除（否则面板会劝人杀掉渲染进程）", () => {
    const all = rows(line(100, 1, 100, "Electron ."), line(300, 100, 100, "Electron Helper (Renderer) --type=renderer"));
    expect(selectOwnedProcs(all, { selfPid: 100, groups: new Map(), runPids: new Map() })).toEqual([]);
  });

  it("run 根进程被认领为 isRunRoot，子孙归到同一 runId", () => {
    const all = rows(line(500, 100, 500, "/bin/bash -c server"), line(501, 500, 500, "node server.js"));
    const procs = selectOwnedProcs(all, { selfPid: 100, groups: new Map(), runPids: new Map([[500, "r-1"]]) });
    expect(procs.map((p) => [p.pid, p.runId, p.isRunRoot])).toEqual([
      [500, "r-1", true],
      [501, "r-1", false],
    ]);
  });

  it("根退了、子孙被 reparent 到 launchd：靠 **pgid = 根 pid** 归到那条 run", () => {
    // `nohup sleep 600 &` 的真实形状：父 bash(500) 已退出，sleep(501) 的 ppid 变 1
    const procs = selectOwnedProcs(rows(line(501, 1, 500, "sleep 600")), {
      selfPid: 100,
      groups: new Map(),
      runPids: new Map([[500, "r-1"]]),
    });
    expect(procs.map((p) => [p.pid, p.runId])).toEqual([[501, "r-1"]]);
  });

  it("组名册里的 runId 会把野子孙也归到那条 run（根退了、子孙还在）", () => {
    const g = new Map<number, GroupOwner>([[500, { at: 1, command: "bash -c server", cwd: "/tmp", runId: "r-1" }]]);
    const procs = selectOwnedProcs(rows(line(501, 1, 500, "node server.js")), {
      selfPid: 100,
      groups: g,
      runPids: new Map(),
    });
    expect(procs[0]!.runId).toBe("r-1");
    expect(procs[0]!.isRunRoot).toBe(false);
  });

  it("前台命令**本体**不列（组根还活着 ⇒ 当前这轮 llm 自己的事，用户 2026-10-24 口径）", () => {
    // 实测症状：agent 每跑一条 `rg`/`tsc`，面板就闪一条「野进程」，命令一结束又没了
    const fg = new Map<number, GroupOwner>([[500, { at: 1000, command: "bash -c rg x", cwd: "/tmp" }]]);
    const all = rows(line(500, 100, 500, "/bin/bash -c rg x"), line(501, 500, 500, "rg x"));
    expect(selectOwnedProcs(all, { selfPid: 100, groups: fg, runPids: new Map() })).toEqual([]);
  });

  it("组根退了 ⇒ 同一组剩下的孤儿立刻列出来（`nohup … &` 那类）", () => {
    const fg = new Map<number, GroupOwner>([[500, { at: 1000, command: "nohup sleep 600 &", cwd: "/tmp" }]]);
    const all = rows(line(501, 1, 500, "sleep 600"));
    expect(selectOwnedProcs(all, { selfPid: 100, groups: fg, runPids: new Map() }).map((p) => p.pid)).toEqual([501]);
  });

  it("输出按 pid 升序（表格不会每刷一次就跳行）", () => {
    const all = rows(line(130, 1, 120, "b"), line(121, 1, 120, "a"), line(125, 1, 120, "c"));
    expect(selectOwnedProcs(all, { selfPid: 100, groups, runPids: new Map() }).map((p) => p.pid)).toEqual([121, 125, 130]);
  });

  it("祖先链成环也不死循环（脏 ps 快照不许把面板拖死）", () => {
    const all = rows(line(200, 201, 200, "a"), line(201, 200, 200, "b"));
    expect(() => selectOwnedProcs(all, { selfPid: 100, groups: new Map(), runPids: new Map() })).not.toThrow();
  });
});

describe("lineage 认领（Windows 无进程组：PPID 锚点）", () => {
  const at = 1_000_000;
  const groups = new Map<number, GroupOwner>([
    [500, { at, command: "bash -c 'nohup sleep 600 &'", cwd: "/tmp", runId: "r-1" }],
  ]);
  const runPids = new Map([[500, "r-1"]]);
  const now = at + 1_000;

  it("根 bash 已退：孤儿的 PPID 仍指向死掉的根 pid ⇒ 锚点不在快照里也能认领", () => {
    // Windows 不 reparent：sleep 的 ppid 还是 500（已退出），pgid 是自己
    const all = [line(501, 500, 501, "sleep 600", at + 100)];
    const procs = selectOwnedProcs(all, { selfPid: 100, groups, runPids, now });
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({
      pid: 501,
      runId: "r-1",
      claim: "lineage",
      anchorPid: 500,
      isRunRoot: false,
    });
  });

  it("中间节点还活着：孙进程也能沿父链回到死掉的根", () => {
    const all = [line(600, 500, 600, "sh -c x", at + 100), line(601, 600, 601, "sleep 600", at + 200)];
    const procs = selectOwnedProcs(all, { selfPid: 100, groups, runPids, now });
    expect(procs.map((p) => [p.pid, p.claim, p.anchorPid])).toEqual([
      [600, "lineage", 500],
      [601, "lineage", 500],
    ]);
  });

  it("锚点 pid 被复用（快照里的创建时刻与登记不符）⇒ 立刻退休，连根自己也不算 run-root", () => {
    const reused = at + 60_000;
    const all = [line(500, 1, 5000, "unrelated-new.exe", reused), line(501, 500, 5001, "child.exe", reused)];
    expect(selectOwnedProcs(all, { selfPid: 100, groups, runPids, now: reused + 100 })).toEqual([]);
  });

  it("长跑 >24h：锚点还活着且创建时刻吻合 ⇒ 晚出生的孩子仍被认领", () => {
    const all = [line(500, 1, 5000, "dev-server", at), line(501, 500, 5001, "worker", at + 29 * 60 * 60 * 1000)];
    const procs = selectOwnedProcs(all, { selfPid: 100, groups, runPids, now: at + 30 * 60 * 60 * 1000 });
    expect(procs.map((p) => [p.pid, p.claim])).toEqual([
      [500, "run-root"],
      [501, "lineage"],
    ]);
  });

  it("锚点不在快照里 ⇒ 不按年龄退休（号空着 = 没被复用），30 天后仍认领孤儿", () => {
    const all = [line(501, 500, 501, "sleep 600", at + 100)];
    const procs = selectOwnedProcs(all, { selfPid: 100, groups, runPids, now: at + 30 * 24 * 60 * 60 * 1000 });
    expect(procs.map((p) => [p.pid, p.claim])).toEqual([[501, "lineage"]]);
  });

  it("拿不到创建时刻 ⇒ 7 天保险丝：超龄锚点退休", () => {
    const all = [line(500, 1, 5000, "old-root"), line(501, 500, 5001, "sleep 600", at + 100)];
    expect(selectOwnedProcs(all, { selfPid: 100, groups, runPids, now: at + 8 * 24 * 60 * 60 * 1000 })).toEqual([]);
  });

  it("父链断在快照外（中间节点缺失）⇒ 不猜、不认领", () => {
    const all = [line(601, 999, 601, "sleep 600", at + 100)];
    expect(selectOwnedProcs(all, { selfPid: 100, groups, runPids, now })).toEqual([]);
  });

  it("前台命令（锚点无 runId 且还活着）⇒ 子孙不列；锚点一退才列孤儿", () => {
    const fg = new Map<number, GroupOwner>([[700, { at, command: "bash -c rg x", cwd: "/tmp" }]]);
    const alive = [line(700, 1, 700, "bash -c rg x", at + 10), line(701, 700, 701, "rg x", at + 20)];
    expect(selectOwnedProcs(alive, { selfPid: 100, groups: fg, runPids: new Map(), now })).toEqual([]);
    const orphan = [line(701, 700, 701, "rg x", at + 20)];
    const procs = selectOwnedProcs(orphan, { selfPid: 100, groups: fg, runPids: new Map(), now });
    expect(procs.map((p) => [p.pid, p.claim, p.runId])).toEqual([[701, "lineage", null]]);
  });
});

describe("childrenOfRun — run 名下进程 ≠ 根进程", () => {
  it("只取该 run 的子孙（根退了、子孙还在时要看得见）", () => {
    const all = rows(line(500, 100, 500, "bash"), line(501, 500, 500, "node a.js"), line(502, 500, 500, "node b.js"));
    const procs = selectOwnedProcs(all, { selfPid: 100, groups: new Map(), runPids: new Map([[500, "r-1"]]) });
    expect(childrenOfRun(procs, "r-1").map((p) => p.pid)).toEqual([501, 502]);
  });
});
