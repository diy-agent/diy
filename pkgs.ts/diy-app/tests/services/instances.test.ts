// 实例大盘的聚合层：扫进程 + 注册表 + 活体探测 → 一行行实例；唤起的两条路（RPC / osascript）。
//
// 这里测的是**合并与降级规则**（网络与 ps 全部注入）：哪些字段谁能覆盖谁、
// 探测失败要标成什么、老实例（没有 instances.self）怎么退、唤起失败为什么必须抛。
// 真起 Electron 的那部分在 tests/cli.intent.instances.test.ts。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstances, focusInstance, psEnvironments, sourceSummary } from "../../src/main/services/instances";
import { writeRecord } from "../../src/main/core/instance-registry";
import type { InstanceRow, InstanceSelf } from "../../src/shared/instance-row";

const ELECTRON = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const APP = "/repo/pkgs.ts/diy-app";

const PS = [
  ` 10     1 ${ELECTRON} ${APP}/build/prod/main/index.mjs --remote-debugging-port=0`,
  ` 11     1 ${ELECTRON} ${APP}/build/preview/main/index.mjs --remote-debugging-port=0`,
  ` 12     1 ${ELECTRON} ${APP}/build/prod/main/index.mjs --remote-debugging-port=0`,
].join("\n");

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "diy-inst-agg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

describe("collectInstances：注册表 ⊕ 进程 ⊕ 自报", () => {
  it("注册表给「谁开的 / 真数据根 / 端口」，自报覆盖身份与活跃会话", async () => {
    const dir = scratch();
    writeRecord(dir, {
      pid: 10,
      port: 18888,
      diyHome: "/Users/ccc/.diy",
      variant: "prod",
      env: "production",
      argv: [ELECTRON, `${APP}/build/prod/main/index.mjs`],
      cwd: "/repo/pkgs.ts/diy-app",
      startedAt: "2026-10-17T08:00:00.000Z",
      updatedAt: "2026-10-17T08:00:00.000Z",
      parents: [{ pid: 9, command: "bash ./sha.sh preview" }],
    });
    const rows = await collectInstances({
      ps: () => PS,
      dir,
      alive: () => true,
      envOf: () => new Map(),
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
      source: "bash ./sha.sh preview",
      sourceKind: "registry",
      sessions: 2,
      running: 1,
    });
    expect(row.window).toEqual({ visible: true, fullScreen: false, minimized: false });
    expect(row.activeTurns[0]?.uri).toBe("projects/4/tasks/366");
  });

  it("老实例（无 instances.self）→ 退到 getAppInfo：身份有了，会话与窗口如实留空", async () => {
    const dir = scratch();
    writeRecord(dir, {
      pid: 10,
      port: 18888,
      diyHome: "/Users/ccc/.diy",
      variant: "prod",
      env: "production",
      argv: [ELECTRON, `${APP}/build/prod/main/index.mjs`],
      cwd: "/x",
      startedAt: "2026-10-17T08:00:00.000Z",
      updatedAt: "2026-10-17T08:00:00.000Z",
      parents: [],
    });
    const rows = await collectInstances({
      ps: () => PS,
      dir,
      alive: () => true,
      envOf: () => new Map(),
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
    writeRecord(dir, {
      pid: 10, port: 18888, diyHome: "/h", variant: "prod", env: "production",
      argv: [ELECTRON, `${APP}/build/prod/main/index.mjs`], cwd: "/x",
      startedAt: "t", updatedAt: "t", parents: [],
    });
    const rows = await collectInstances({
      ps: () => PS, dir, alive: () => true, envOf: () => new Map(),
      probeSelf: async () => null,
      probeAppInfo: async () => { throw new Error("ECONNREFUSED"); },
    });
    const row = rows.find((r) => r.pid === 10)!;
    expect(row.status).toBe("unreachable");
    expect(row.note).toContain("18888");
  });

  it("未注册的老实例：数据根只当线索（带 `?`），来源标未知，端口来自 app.port 文件", async () => {
    const rows = await collectInstances({
      ps: () => PS,
      dir: scratch(),
      alive: () => true,
      // 只有 pid 12 带着环境线索（pid 10/11 连线索都没有 —— 那才是「什么都拿不到」的老实例）
      envOf: (pids) => new Map(pids.filter((p) => p === 12).map((p) => [p, { DIY_HOME: "/Users/ccc/.diy", DIY_ENV: "production" }])),
      readPortFile: (home) => (home === "/Users/ccc/.diy" ? 18888 : null),
      probeSelf: async (port) => (port === 18888 ? selfOf({ pid: 12 }) : null),
      probeAppInfo: async () => { throw new Error("no"); },
    });
    const row = rows.find((r) => r.pid === 12)!;
    expect(row.sourceKind).toBe("unknown");
    expect(row.source).toBe("来源未知");
    expect(row.homeSource).toBe("self"); // 探测回来后升级成「自报」
    expect(row.note).toContain("未注册"); // 出身说明保留（探测成功不改写「它原本是猜的」）
    // 探测失败/没端口的那两条仍是线索态
    const hintRow = rows.find((r) => r.pid === 10)!;
    expect(hintRow.port).toBeNull();
    expect(hintRow.status).toBe("no-port");
  });

  it("注册表里有、进程扫描没命中（如 serve 跑源码）→ 仍成行，并标注来源", async () => {
    const dir = scratch();
    writeRecord(dir, {
      pid: 77, port: 18889, diyHome: "/repo/build/prod/home", variant: "prod", env: "development",
      argv: ["node", "/repo/pkgs.ts/diy-app/src/serve/index.ts", "--port", "18889"],
      cwd: "/repo", startedAt: "t", updatedAt: "t", parents: [{ pid: 3, command: "npm run serve" }],
    });
    const rows = await collectInstances({
      ps: () => PS, dir, alive: () => true, envOf: () => new Map(),
      probeSelf: async () => null,
      probeAppInfo: async () => ({ diyHome: "/repo/build/prod/home", pid: 77, env: "development" }),
    });
    const row = rows.find((r) => r.pid === 77)!;
    expect(row.kind).toBe("serve");
    expect(row.note).toContain("进程扫描未命中");
    expect(row.source).toContain("npm run serve");
  });

  it("行按 pid 稳定（同根聚类由 instance-table 负责）", async () => {
    const rows = await collectInstances({
      ps: () => PS, dir: scratch(), alive: () => true, envOf: () => new Map(),
      probeSelf: async () => null, probeAppInfo: async () => { throw new Error("no"); },
    });
    expect(rows.map((r) => r.pid)).toEqual([10, 11, 12]);
  });
});

describe("两台同变体实例 ≠ 同一实例（pid 不同就是两行）", () => {
  it("同是 prod 产物、同变体名，但 pid/数据根/端口各不同 → 两行（绝不按「变体名」合并）", async () => {
    const rows = await collectInstances({
      ps: () => ` 10 1 ${ELECTRON} ${APP}/build/prod/main/index.mjs\n 12 1 ${ELECTRON} ${APP}/build/prod/main/index.mjs`,
      dir: scratch(),
      alive: () => true,
      envOf: (pids) => new Map(pids.map((p) => [p, { DIY_HOME: p === 10 ? "/h1" : "/h2" }])),
      readPortFile: (home) => ({ "/h1": 18888, "/h2": 18889 })[home] ?? null,
      probeSelf: async (port) =>
        port === 18888
          ? selfOf({ pid: 10, diyHome: "/h1", diyHomeDisplay: "/h1" })
          : selfOf({ pid: 12, port, diyHome: "/h2", diyHomeDisplay: "/h2" }),
      probeAppInfo: async () => { throw new Error("no"); },
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
      pid: 10, kind: "electron", variant: "prod", diyHome: "/h", diyHomeDisplay: "/h", homeSource: "self",
      env: "production", branch: "", repoDisplay: "", port: 18888, source: "x", sourceKind: "registry",
      cmdline: "", cwd: "", startedAt: null, status: "ready", note: "", sessions: 0, running: 0,
      activeTurns: [], window: null,
    },
  ];

  it("RPC 成功 → via=rpc，不碰 osascript", async () => {
    let osa = 0;
    const r = await focusInstance({ pid: 10 }, {
      collect: rowsOf,
      reveal: async () => ({ ok: true, reason: "已前置并全屏", fullScreen: true }),
      osascript: () => { osa++; return true; },
    });
    expect(r.via).toBe("rpc");
    expect(osa).toBe(0);
  });

  it("目标实例拒绝（serve 无窗口）→ 降级 osascript 成功则 via=osascript", async () => {
    const r = await focusInstance({ pid: 10 }, {
      collect: rowsOf,
      reveal: async () => ({ ok: false, reason: "本实例没有窗口（serve 模式 / 未运行 GUI）", fullScreen: false }),
      osascript: () => true,
    });
    expect(r).toMatchObject({ via: "osascript", pid: 10 });
  });

  it("两路都失败 → 抛错，并把**两条**原因都带上（不静默吞）", async () => {
    await expect(
      focusInstance({ pid: 10 }, {
        collect: rowsOf,
        reveal: async () => { throw new Error("probe timeout 2500ms"); },
        osascript: () => false,
      }),
    ).rejects.toThrow(/RPC 唤起失败[\s\S]*osascript 降级也失败/);
  });

  it("目标不存在 → 明确说「可能已退出」并指路", async () => {
    await expect(focusInstance({ pid: 999 }, { collect: async () => [], osascript: () => false })).rejects.toThrow(/找不到实例 pid=999/);
  });

  it("无端口的行：不发 RPC（没有端口可发）", async () => {
    let revealed = 0;
    const rows = await rowsOf();
    rows[0]!.port = null;
    const r = await focusInstance({ pid: 10 }, { collect: async () => rows, reveal: async () => { revealed++; return { ok: true, reason: "", fullScreen: true }; }, osascript: () => true });
    expect(revealed).toBe(0);
    expect(r.via).toBe("osascript");
  });
});

describe("psEnvironments / sourceSummary（小工具）", () => {
  it("批量 ps eww：一行解析出 pid → 环境变量表", () => {
    const text = [
      "  PID   TT  STAT      TIME COMMAND",
      " 10   ??  Ss     0:01.00 /x/Electron /x/build/prod/main/index.mjs DIY_HOME=/Users/ccc/.diy DIY_ENV=production",
      " 11   ??  Ss     0:02.00 /x/Electron /x/build/preview/main/index.mjs DIY_HOME=/Users/ccc/.diy DIY_VARIANT=preview",
    ].join("\n");
    const envs = psEnvironments([10, 11], () => text);
    expect(envs.get(10)?.["DIY_HOME"]).toBe("/Users/ccc/.diy");
    expect(envs.get(11)?.["DIY_VARIANT"]).toBe("preview");
  });

  it("ps 失败 → 空表（老实例只是少一条线索，不该拖垮整表）", () => {
    expect(psEnvironments([10], () => { throw new Error("ps: 权限"); }).size).toBe(0);
    expect(psEnvironments([]).size).toBe(0);
  });

  it("无父链记录 → 「来源未知」；有则给父命令摘要", () => {
    expect(sourceSummary(undefined)).toBe("来源未知");
    expect(
      sourceSummary({
        pid: 1, port: null, diyHome: "/h", variant: "", env: "", argv: [], cwd: "", startedAt: "", updatedAt: "", parents: [],
      }),
    ).toContain("无父进程记录");
  });
});
