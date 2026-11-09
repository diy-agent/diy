// 实例大盘的聚合层：**只读动态注册表**（实例自报）+ 活体探测 → 一行行实例；唤起的两条路（RPC / 系统级降级）。
//
// 这里测的是**合并与降级规则**（网络与注册表全部注入）：哪些字段谁能覆盖谁、探测失败要标成什么、
// 老实例（没有 instances.self）怎么退、唤起失败为什么必须抛。
//
// 为什么不再有「扫进程」的用例（##518）：发现协议只有两条 —— 静态 `app.yaml`（能起什么）与
// 动态注册表（此刻跑着什么）。进程表看不出身份（数据根 / worktree / 有没有 source 全靠猜），
// 那条路已退役，于是「没有自报记录的进程」本来就**不该**出现。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstances, focusInstance, sourceSummary } from "../../src/main/services/instances";
import { writeRecord, type InstanceRecord } from "../../src/main/core/instance-registry";
import type { InstanceRow, InstanceSelf } from "../../src/shared/instance-row";

const ELECTRON = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const APP = "/repo/apps/diy-app";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "diy-inst-agg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 一条自报记录（只给用例关心的字段，其余取缺省） */
function rec(over: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: 10,
    app: "diy-app",
    launch: null,
    worktree: "/repo",
    name: null,
    mode: "source",
    port: 18888,
    pingPort: null,
    diyHome: "/Users/ccc/.diy",
    variant: "prod",
    env: "production",
    argv: [ELECTRON, `${APP}/build/prod/main/index.mjs`],
    cwd: "/repo/apps/diy-app",
    startedAt: "2026-10-17T08:00:00.000Z",
    updatedAt: "2026-10-17T08:00:00.000Z",
    parents: [{ pid: 9, command: "bash ./sha.sh lab" }],
    ...over,
  };
}

function selfOf(over: Partial<InstanceSelf> = {}): InstanceSelf {
  return {
    pid: 10,
    port: 18888,
    diyHome: "/Users/ccc/.diy",
    diyHomeDisplay: "~/.diy",
    env: "production",
    variant: "prod",
    branch: "main",
    repoDisplay: "diy",
    startedAt: "2026-10-17T08:00:00.000Z",
    sessions: 2,
    running: 1,
    activeTurns: [{ uri: "projects/4/tasks/366", since: "2026-10-17T08:00:00.000Z", steps: 3 }],
    window: { visible: true, fullScreen: false, minimized: false },
    ...over,
  };
}

describe("collectInstances：注册表自报 + 活体探测", () => {
  it("注册表给「谁开的 / 真数据根 / 端口」，自报覆盖身份与活跃会话", async () => {
    const dir = scratch();
    writeRecord(dir, rec());
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async (port) => (port === 18888 ? selfOf() : null),
      probeAppInfo: async () => {
        throw new Error("不该走到老实例退路");
      },
    });
    const row = rows.find((r) => r.pid === 10)!;
    expect(row).toMatchObject({
      pid: 10,
      port: 18888,
      status: "ready",
      homeSource: "self",
      diyHome: "/Users/ccc/.diy",
      variant: "prod",
      branch: "main",
      source: "bash ./sha.sh lab",
      sourceKind: "registry",
      sessions: 2,
      running: 1,
      mode: "source",
    });
    expect(row.window).toEqual({ visible: true, fullScreen: false, minimized: false });
    expect(row.activeTurns[0]?.uri).toBe("projects/4/tasks/366");
  });

  it("老实例（无 instances.self）→ 退到 getAppInfo：身份有了，会话与窗口如实留空", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ parents: [] }));
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => ({ diyHome: "/Users/ccc/.diy", pid: 10, env: "production", port: 18888, branch: "main" }),
    });
    const row = rows.find((r) => r.pid === 10)!;
    expect(row.status).toBe("ready");
    expect(row.homeSource).toBe("self");
    expect(row.sessions).toBe(0);
    expect(row.window).toBeNull();
    expect(row.note).toContain("老实例");
  });

  it("有端口但两路都不答 → unreachable（**明确区别于 no-port**）", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ diyHome: "/h" }));
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const row = rows.find((r) => r.pid === 10)!;
    expect(row.status).toBe("unreachable");
    expect(row.note).toContain("18888");
  });

  it("名字：自报优先；没写就 `<app>#<pid>`，连 app 都不知道就 `diy#<pid>`", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ pid: 10, name: "lab-调试" }));
    writeRecord(dir, rec({ pid: 11, name: null }));
    writeRecord(dir, rec({ pid: 12, name: null, app: null }));
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => {
        throw new Error("no");
      },
    });
    const by = (pid: number) => rows.find((r) => r.pid === pid)!;
    expect(by(10).displayName).toBe("lab-调试");
    expect(by(11).displayName).toBe("diy-app#11");
    expect(by(12).displayName).toBe("diy#12");
    expect(by(11).name).toBe(""); // 没名字就是空串，不编一个假名
  });

  it("打包态没有 source ⇒ worktree 置空（身份只看有 source 的那一半）", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ pid: 20, mode: "packaged", worktree: "/repo" }));
    writeRecord(dir, rec({ pid: 21, mode: "source", worktree: "/repo" }));
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => {
        throw new Error("no");
      },
    });
    const by = (pid: number) => rows.find((r) => r.pid === pid)!;
    expect(by(20).mode).toBe("packaged");
    expect(by(20).worktree).toBe("");
    expect(by(21).worktree).toBe("/repo");
    expect(by(21).worktreeDisplay).not.toBe("");
  });

  it("没有自报记录的进程**不出现**（扫进程已退役）", async () => {
    const rows = await collectInstances({
      dir: scratch(),
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => {
        throw new Error("no");
      },
    });
    expect(rows).toEqual([]);
  });

  it("死记录被 pid 存活过滤挡掉（SIGKILL 留下的文件不冒充实例）", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ pid: 10 }));
    writeRecord(dir, rec({ pid: 11 }));
    const rows = await collectInstances({
      dir,
      alive: (pid) => pid === 10,
      probeSelf: async () => null,
      probeAppInfo: async () => {
        throw new Error("no");
      },
    });
    expect(rows.map((r) => r.pid)).toEqual([10]);
  });

  it("行按 pid 稳定、同 pid 只有一行（聚类排序由 instance-table 负责）", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ pid: 10 }));
    writeRecord(dir, rec({ pid: 11 }));
    writeRecord(dir, rec({ pid: 12 }));
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => {
        throw new Error("no");
      },
    });
    expect(rows.map((r) => r.pid).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it("serve 入口按 argv 认出来（kind 不是身份，只是「有没有窗口」的提示）", async () => {
    const dir = scratch();
    writeRecord(
      dir,
      rec({
        pid: 77,
        port: 18889,
        argv: ["node", "/repo/apps/diy-app/src/serve/index.ts", "--port", "18889"],
        parents: [{ pid: 3, command: "npm run serve" }],
      }),
    );
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async () => null,
      probeAppInfo: async () => ({ diyHome: "/repo/build/prod/home", pid: 77, env: "development" }),
    });
    const row = rows.find((r) => r.pid === 77)!;
    expect(row.kind).toBe("serve");
    expect(row.source).toContain("npm run serve");
  });
});

describe("两台同变体实例 ≠ 同一实例（pid 不同就是两行）", () => {
  it("同是 prod 产物、同变体名，但 pid/数据根/端口各不同 → 两行（绝不按「变体名」合并）", async () => {
    const dir = scratch();
    writeRecord(dir, rec({ pid: 10, diyHome: "/h1" }));
    writeRecord(dir, rec({ pid: 12, diyHome: "/h2", port: 18889 }));
    const rows = await collectInstances({
      dir,
      alive: () => true,
      probeSelf: async (port) =>
        port === 18888
          ? selfOf({ pid: 10, diyHome: "/h1", diyHomeDisplay: "/h1" })
          : selfOf({ pid: 12, port, diyHome: "/h2", diyHomeDisplay: "/h2" }),
      probeAppInfo: async () => {
        throw new Error("no");
      },
    });
    const homed = rows.filter((r) => r.diyHome !== "");
    expect(homed.map((r) => [r.pid, r.diyHome, r.port])).toEqual([
      [10, "/h1", 18888],
      [12, "/h2", 18889],
    ]);
  });
});

describe("focusInstance：RPC 优先，失败降级，双失败必抛", () => {
  const rowsOf = async (): Promise<InstanceRow[]> => [
    {
      pid: 10,
      kind: "electron",
      mode: "source",
      worktree: "/x",
      worktreeDisplay: "x",
      name: "",
      displayName: "diy-app#10",
      variant: "prod",
      diyHome: "/h",
      diyHomeDisplay: "/h",
      homeSource: "self",
      env: "production",
      branch: "",
      repoDisplay: "",
      port: 18888,
      source: "x",
      sourceKind: "registry",
      cmdline: "",
      cwd: "",
      startedAt: null,
      status: "ready",
      note: "",
      sessions: 0,
      running: 0,
      activeTurns: [],
      window: null,
    },
  ];

  it("RPC 成功 → via=rpc，不碰系统级降级", async () => {
    let osa = 0;
    const r = await focusInstance(
      { pid: 10 },
      {
        collect: rowsOf,
        reveal: async () => ({ ok: true, reason: "已前置并全屏", fullScreen: true }),
        focus: () => {
          osa++;
          return true;
        },
      },
    );
    expect(r.via).toBe("rpc");
    expect(osa).toBe(0);
  });

  it("目标实例拒绝（serve 无窗口）→ 降级系统级唤起成功则 via=system", async () => {
    const r = await focusInstance(
      { pid: 10 },
      {
        collect: rowsOf,
        reveal: async () => ({ ok: false, reason: "本实例没有窗口（serve 模式 / 未运行 GUI）", fullScreen: false }),
        focus: () => true,
      },
    );
    expect(r).toMatchObject({ via: "system", pid: 10 });
  });

  it("两路都失败 → 抛错，并把**两条**原因都带上（不静默吞）", async () => {
    await expect(
      focusInstance(
        { pid: 10 },
        {
          collect: rowsOf,
          reveal: async () => {
            throw new Error("probe timeout 2500ms");
          },
          focus: () => false,
        },
      ),
    ).rejects.toThrow(/probe timeout 2500ms[\s\S]*系统级降级也失败/);
  });

  it("找不到目标 → 明确报错并指路（不静默成功）", async () => {
    await expect(focusInstance({ pid: 999 }, { collect: rowsOf })).rejects.toThrow(/找不到实例/);
  });
});

describe("sourceSummary：「谁开的」摘要", () => {
  it("无记录 → 来源未知", () => {
    expect(sourceSummary(undefined)).toBe("来源未知");
  });
  it("有父进程 → 第一跳 command（截断）", () => {
    expect(sourceSummary(rec({ parents: [{ pid: 9, command: "bash ./sha.sh lab" }] }))).toBe("bash ./sha.sh lab");
  });
  it("没父进程记录 → 如实说明，不编一个来源", () => {
    expect(sourceSummary(rec({ pid: 3, parents: [] }))).toContain("无父进程记录");
  });
});
