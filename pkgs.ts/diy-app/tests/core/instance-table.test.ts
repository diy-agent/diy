// 实例表格的展示层：排序 + 对齐（纯函数）。
//
// 为什么要测排版：表格是「人读」的唯一出口，错位/截断错了就等于没有可读性；
// 而它完全由输入决定 —— 不给它单测，就只能靠起 Electron 肉眼比对。
import { describe, expect, it } from "vitest";
import { clipDisplay, displayWidth, padDisplay, renderInstanceTable, sortInstanceRows } from "../../src/main/core/instance-table";
import type { InstanceRow } from "../../src/shared/instance-row";

function row(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    pid: 100,
    kind: "electron",
    variant: "prod",
    diyHome: "/Users/ccc/.diy",
    diyHomeDisplay: "~/.diy",
    homeSource: "self",
    env: "production",
    branch: "main",
    repoDisplay: "diy",
    port: 18888,
    source: "bash ./sha.sh lab",
    sourceKind: "registry",
    cmdline: "Electron /x/build/prod/main/index.mjs",
    cwd: "/x",
    startedAt: "2026-10-17T08:30:00.000Z",
    status: "ready",
    note: "",
    sessions: 2,
    running: 1,
    activeTurns: [{ uri: "projects/4/tasks/366", since: "2026-10-17T08:00:00.000Z", steps: 3 }],
    window: { visible: true, fullScreen: false, minimized: false },
    ...over,
  };
}

describe("排序：按数据根聚类，未知排最后", () => {
  it("同根相邻 + 组内 pid 升序", () => {
    const rows = [
      row({ pid: 30, diyHome: "/b" }),
      row({ pid: 10, diyHome: "/a" }),
      row({ pid: 20, diyHome: "/a" }),
    ];
    expect(sortInstanceRows(rows).map((r) => r.pid)).toEqual([10, 20, 30]);
  });

  it("数据根未知（空串）的行排在已知根之后", () => {
    const rows = [row({ pid: 1, diyHome: "" }), row({ pid: 2, diyHome: "/a" })];
    expect(sortInstanceRows(rows).map((r) => r.pid)).toEqual([2, 1]);
  });

  it("不改原数组", () => {
    const rows = [row({ pid: 2 }), row({ pid: 1 })];
    sortInstanceRows(rows);
    expect(rows.map((r) => r.pid)).toEqual([2, 1]);
  });
});

describe("显示宽度：中文按 2 格（否则整列错位）", () => {
  it("displayWidth", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("数据根")).toBe(6);
    expect(displayWidth("a数据")).toBe(5);
  });

  it("clipDisplay 按宽度截断并加省略号", () => {
    expect(clipDisplay("abcdef", 10)).toBe("abcdef");
    expect(clipDisplay("abcdefg", 5)).toBe("abcd…");
    expect(clipDisplay("中文中文", 5)).toBe("中文…"); // 宽度 4 + 省略号，正好 5
  });

  it("padDisplay 按显示宽度补齐（不是按 length）", () => {
    expect(padDisplay("中文", 6)).toBe("中文  ");
    expect(displayWidth(padDisplay("中文", 8))).toBe(8);
  });
});

describe("renderInstanceTable", () => {
  it("含表头、实例行与汇总行；每行能对上数据根与变体", () => {
    const text = renderInstanceTable([row({ pid: 2339 }), row({ pid: 7777, variant: "test", env: "test", diyHome: "/tmp/h", diyHomeDisplay: "/tmp/h", port: null, status: "no-port", sessions: 0, running: 0, activeTurns: [] })]);
    const lines = text.split("\n");
    expect(lines[0]).toContain("PID");
    expect(lines[0]).toContain("数据根");
    expect(lines[0]).toContain("变体");
    expect(text).toContain("2339");
    expect(text).toContain("~/.diy");
    expect(text).toContain("/tmp/h");
    expect(text).toContain("test");
    expect(text).toContain("共 2 个实例（1 个可唤起）");
  });

  it("note 逐行附在表下（问题不藏在格子里）", () => {
    const text = renderInstanceTable([row({ pid: 5, status: "unreachable", note: "端口 1234 无响应" })]);
    expect(text).toContain("[5] 端口 1234 无响应");
  });

  it("空表也能渲染（只有表头与「共 0 个」）", () => {
    const text = renderInstanceTable([]);
    expect(text).toContain("共 0 个实例（0 个可唤起）");
  });

  it("会话列：ready 才显示，跑轮才追加", () => {
    const withTurn = renderInstanceTable([row()]);
    expect(withTurn).toMatch(/2 会话 · 1 跑轮/);
    const noTurn = renderInstanceTable([row({ sessions: 3, running: 0 })]);
    expect(noTurn).toContain("3 会话");
    expect(noTurn).not.toContain("跑轮");
    const notReady = renderInstanceTable([row({ status: "no-port", port: null })]);
    expect(notReady).not.toContain("会话 ·");
  });
});
