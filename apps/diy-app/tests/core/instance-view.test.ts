// 实例页（导航「实例」，##367）的展示语义：纯函数。
//
// 为什么要测这些（##329 R1）：它们是**可判定的** —— 能不能唤起、谁排前面、这一刻该不该轮询、
// 刷新后选中怎么留。不给它们单测，就只能起 Electron 靠截图肉眼比对，改一处判定没人拦得住。
import { describe, expect, it } from "vitest";
import {
  ACTIVE_TASK_SHOWN,
  DEFAULT_INSTANCE_SORT,
  INSTANCE_COLUMNS,
  INSTANCE_POLL_MS,
  activeTasksLabel,
  decidePoll,
  focusReadiness,
  homeLabel,
  homeTip,
  keepPid,
  nextSort,
  sortRowsForUi,
  sourceLabel,
  statusView,
  summarizeRows,
  taskLabel,
  type InstanceViewCtx,
} from "../../src/shared/instance-view";
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

/** 任务号/标题解析桩：只在「本实例的任务树」里有 */
const ctxOf = (known: Record<string, { num: string; title: string }>): InstanceViewCtx => ({
  taskOf: (uri) => known[uri] ?? null,
});

describe("列清单：口径对齐 CLI instances ls，且不显示任务状态（##350 的教训）", () => {
  it("列键覆盖 CLI 表格的口径 + 本页新增的「当前任务」", () => {
    const keys = INSTANCE_COLUMNS.map((c) => c.key);
    expect(keys).toEqual([
      "pid",
      "source",
      "home",
      "variant",
      "env",
      "branch",
      "port",
      "status",
      "task",
      "session",
      "started",
    ]);
  });

  it("没有任何「任务状态」列/文案 —— 免得这张表被读成任务列表", () => {
    for (const c of INSTANCE_COLUMNS) {
      expect(c.title).not.toContain("任务状态");
      expect(c.headTip).not.toContain("任务状态");
    }
  });

  it("每列都能对一行取值（不抛、不返回 undefined）", () => {
    const r = row();
    for (const c of INSTANCE_COLUMNS) {
      const t = c.text(r, {});
      expect(typeof t, `列 ${c.key}`).toBe("string");
      expect(t, `列 ${c.key}`).not.toContain("undefined");
    }
  });
});

describe("状态：原值 → 人话 + 色调（判据仍是原值）", () => {
  it("四种已知状态各有文案与色调", () => {
    expect(statusView("ready")).toMatchObject({ label: "就绪", tone: "ok" });
    expect(statusView("no-port")).toMatchObject({ label: "无端口", tone: "warn" });
    expect(statusView("unreachable")).toMatchObject({ label: "无响应", tone: "err" });
    expect(statusView("unregistered")).toMatchObject({ label: "未注册", tone: "ghost" });
  });

  it("未知状态原样显示（不猜、也不装成就绪）", () => {
    expect(statusView("weird").label).toBe("weird");
    expect(statusView("").label).toBe("未知");
  });
});

describe("数据根 / 来源：能自报的才算真根", () => {
  it("hint 只是线索 → tooltip 必须说清（环境变量是继承来的）", () => {
    const r = row({ homeSource: "hint", diyHomeDisplay: "~/.diy?" });
    expect(homeLabel(r)).toBe("~/.diy?");
    expect(homeTip(r)).toContain("环境变量");
  });

  it("自报 / 注册表 / 全无线索三种来源各有一句话", () => {
    expect(homeTip(row({ homeSource: "self" }))).toContain("自己报的");
    expect(homeTip(row({ homeSource: "registry" }))).toContain("注册表");
    expect(homeTip(row({ homeSource: "unknown", diyHome: "", diyHomeDisplay: "" }))).toContain("未知");
    expect(homeLabel(row({ diyHomeDisplay: "" }))).toBe("?");
  });

  it("来源为空时按 sourceKind 区分「来源未知」与「注册表没记来源」", () => {
    expect(sourceLabel(row({ source: "", sourceKind: "unknown" }))).toBe("来源未知");
    expect(sourceLabel(row({ source: "", sourceKind: "registry" }))).toContain("未记来源");
    expect(sourceLabel(row({ source: "由 launchd 接管" }))).toBe("由 launchd 接管");
  });
});

describe("任务标签：本树里有就「#号 标题」，没有就退回 uri 里的号", () => {
  it("查得到", () => {
    const ctx = ctxOf({ "projects/4/tasks/366": { num: "366", title: "实例大盘（一）" } });
    expect(taskLabel("projects/4/tasks/366", ctx)).toBe("#366 实例大盘（一）");
  });

  it("查不到 → 用 uri 末段的号（别的数据根上的任务只有这个可读）", () => {
    expect(taskLabel("projects/9/tasks/42", {})).toBe("#42");
  });

  it("连号都取不到 → 原样给 uri（不装懂）", () => {
    expect(taskLabel("local/abc", {})).toBe("local/abc");
  });

  it("在跑任务列：空 → —；多于两轮折算 +N", () => {
    expect(activeTasksLabel(row({ activeTurns: [] }), {})).toBe("—");
    const turns = [1, 2, 3].map((n) => ({ uri: `projects/4/tasks/${n}`, since: "2026-10-17T00:00:00.000Z", steps: n }));
    const s = activeTasksLabel(row({ activeTurns: turns }), {});
    expect(s).toBe("#1、#2 +1");
    expect(ACTIVE_TASK_SHOWN).toBe(2);
  });
});

describe("能唤起吗：先给判据，再让按钮说话", () => {
  it("有端口且探测通 → 由目标实例自己唤起（不需要系统权限）", () => {
    const r = focusReadiness(row());
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("目标实例自己");
  });

  it("无端口但有窗口（electron）→ 允许，但说明要走系统级降级", () => {
    const r = focusReadiness(row({ port: null, status: "no-port" }));
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("系统级唤起");
  });

  it("无端口且不是 Electron（serve 源码跑）→ 不可唤起并说清原因", () => {
    const r = focusReadiness(row({ port: null, kind: "serve", status: "no-port" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("没有窗口可唤起");
  });

  it("端口不答话 → 仍可试（会降级），但先提醒", () => {
    const r = focusReadiness(row({ status: "unreachable" }));
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("unreachable");
  });

  it("已经全屏 → 说明本次只会前置", () => {
    const r = focusReadiness(row({ window: { visible: true, fullScreen: true, minimized: false } }));
    expect(r.reason).toContain("已是全屏");
  });

  it("汇总：可唤起数不等于总行数", () => {
    const rows = [row({ pid: 1 }), row({ pid: 2, port: null, kind: "serve", status: "no-port" })];
    expect(summarizeRows(rows)).toEqual({ total: 2, focusable: 1 });
  });
});

describe("排序", () => {
  it("缺省 = CLI 的序（按数据根聚类，未知根最后）", () => {
    const rows = [row({ pid: 3, diyHome: "" }), row({ pid: 2, diyHome: "/b" }), row({ pid: 1, diyHome: "/a" })];
    expect(sortRowsForUi(rows, DEFAULT_INSTANCE_SORT).map((r) => r.pid)).toEqual([1, 2, 3]);
  });

  it("按 pid 升降序", () => {
    const rows = [row({ pid: 30 }), row({ pid: 10 }), row({ pid: 20 })];
    expect(sortRowsForUi(rows, { key: "pid", dir: "asc" }).map((r) => r.pid)).toEqual([10, 20, 30]);
    expect(sortRowsForUi(rows, { key: "pid", dir: "desc" }).map((r) => r.pid)).toEqual([30, 20, 10]);
  });

  it("按状态：有问题的排前面", () => {
    const rows = [
      row({ pid: 1, status: "ready" }),
      row({ pid: 2, status: "unreachable" }),
      row({ pid: 3, status: "no-port" }),
      row({ pid: 4, status: "unregistered" }),
    ];
    expect(sortRowsForUi(rows, { key: "status", dir: "asc" }).map((r) => r.pid)).toEqual([2, 3, 4, 1]);
  });

  it("按启动时刻：没有时刻的（老实例）恒排最后，升序降序都一样", () => {
    const rows = [
      row({ pid: 1, startedAt: null }),
      row({ pid: 2, startedAt: "2026-10-17T10:00:00.000Z" }),
      row({ pid: 3, startedAt: "2026-10-17T09:00:00.000Z" }),
    ];
    expect(sortRowsForUi(rows, { key: "started", dir: "asc" }).map((r) => r.pid)).toEqual([3, 2, 1]);
    expect(sortRowsForUi(rows, { key: "started", dir: "desc" }).map((r) => r.pid)).toEqual([2, 3, 1]);
  });

  it("同键一律以 pid 收口（刷新前后不会自己换位）", () => {
    const rows = [row({ pid: 9, status: "ready" }), row({ pid: 2, status: "ready" }), row({ pid: 5, status: "ready" })];
    expect(sortRowsForUi(rows, { key: "status", dir: "asc" }).map((r) => r.pid)).toEqual([2, 5, 9]);
  });

  it("不改原数组", () => {
    const rows = [row({ pid: 2 }), row({ pid: 1 })];
    sortRowsForUi(rows, { key: "pid", dir: "asc" });
    expect(rows.map((r) => r.pid)).toEqual([2, 1]);
  });

  it("点表头：同列翻方向，换列回缺省方向", () => {
    expect(nextSort({ key: "pid", dir: "asc" }, "pid")).toEqual({ key: "pid", dir: "desc" });
    expect(nextSort({ key: "pid", dir: "desc" }, "pid")).toEqual({ key: "pid", dir: "asc" });
    expect(nextSort({ key: "pid", dir: "desc" }, "home")).toEqual({ key: "home", dir: "asc" });
    expect(nextSort({ key: "home", dir: "asc" }, "started")).toEqual({ key: "started", dir: "desc" });
  });
});

describe("刷新后选中/展开怎么留（判据 = pid，不是行对象、不是下标）", () => {
  it("还在盘里 → 保留", () => {
    expect(keepPid(7, [row({ pid: 7 }), row({ pid: 8 })])).toBe(7);
  });

  it("实例退出了 → 清空（而不是悄悄挪到别人身上）", () => {
    expect(keepPid(7, [row({ pid: 8 })])).toBeNull();
    expect(keepPid(7, [])).toBeNull();
  });

  it("本来就没选 → 保持没选", () => {
    expect(keepPid(null, [row({ pid: 7 })])).toBeNull();
  });
});

describe("轮询：不可见即停，且首屏不受它约束", () => {
  const base = { visible: true, inFlight: false, now: 10_000, lastDoneAt: 9_000, intervalMs: INSTANCE_POLL_MS };

  it("从没刷过 → 立刻刷（后台标签页打开时也得有内容）", () => {
    expect(decidePoll({ ...base, visible: false, lastDoneAt: null })).toEqual({ action: "poll" });
  });

  it("页面不可见 → 停（不是慢一点）", () => {
    expect(decidePoll({ ...base, visible: false })).toMatchObject({ action: "pause" });
  });

  it("上一轮还在飞 → 等，不并发堆探测", () => {
    expect(decidePoll({ ...base, inFlight: true, now: 99_999 })).toEqual({ action: "wait", waitMs: INSTANCE_POLL_MS });
  });

  it("不足间隔 → 等剩下的时间（节拍器 500ms ≠ 间隔 3s）", () => {
    expect(decidePoll({ ...base, now: 9_500 })).toEqual({ action: "wait", waitMs: INSTANCE_POLL_MS - 500 });
  });

  it("到点 → 刷", () => {
    expect(decidePoll({ ...base, now: 9_000 + INSTANCE_POLL_MS })).toEqual({ action: "poll" });
  });
});
