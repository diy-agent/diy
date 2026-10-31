// src/main/services/instances.ts
// 🎯 实例大盘的**聚合层**：发现（扫进程 + 注册表）→ 活体探测 → 一行行实例。
//
// 三个关键设计点（任务 body，均已实测）：
//   1. **发现靠扫进程**：没有「有哪些数据根」的索引（`app.port` 是「一个数据根一份」），
//      唯一能枚举本机实例的办法是扫进程。
//   2. **「谁开的」靠启动时自报**：实测生产实例 `ppid=1`（父已退、被 launchd 接管）——
//      事后追父链追不出来，故注册表（`core/instance-registry.ts`）在启动瞬间快照。
//   3. **真数据根靠自报**：`ps eww` 里的 `DIY_HOME` 是**继承**来的，不等于实例真根
//      （实测 `pid=11419 DIY_HOME=~/.diy` 而它的子进程真根在 worktree 的 `build/<v>/home`）。
//      故 hint 只作线索，`homeSource=self` 的行才是真根。
//
// 纯逻辑（ps 解析 / 分类 / 去重 / 排序 / 排版）都在 core，这里只做 I/O 与编排：
// 起 ps、读注册表、发探测、合并 —— 于是「规则」可单测，「网络」可注入（见 CollectDeps）。

import { execFileSync } from "node:child_process";
import { AppConfig } from "../core/app-config";
import { homeDisplayOf } from "../core/instance-identity";
import { cmdlineSummary, parsePsOutput, pickInstanceProcesses, type InstanceProcess } from "../core/instance-scan";
import {
  readRecords,
  registryDir,
  removeRecord,
  snapshotParents,
  updateRecord,
  writeRecord,
  type InstanceRecord,
} from "../core/instance-registry";
import { renderInstanceTable } from "../core/instance-table";
import { fetchAppInfo, fetchInstanceSelf, revealInstance, type AppInfoLite, type InstanceSelf } from "./instance-probe";
import { sessionRegistry } from "./session-registry";
import * as state from "../core/state";
import type { InstanceRow, InstanceTurn } from "../../shared/instance-row";

/** 本进程的启动时刻（`process.uptime()` 反推 —— 不依赖模块加载时机） */
export function selfStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** 探测预算：单行最坏 = self 超时 + getAppInfo 超时；各行并发，故整表延迟 ≈ 这个量级 */
const PROBE_TIMEOUT_MS = 1200;

// ── 注册表生命周期（本进程 = 自己那条记录的主人） ─────────────────

/** 启动时写自己那一条（父进程链此刻还在 —— 这是唯一的快照时机，见 registry 文件头注） */
export function writeSelfRecord(opts: { diyHome: string; variant: string; env: string }): void {
  writeRecord(registryDir(), {
    pid: process.pid,
    port: null,
    pingPort: null,
    diyHome: opts.diyHome,
    variant: opts.variant,
    env: opts.env,
    argv: [...process.argv],
    cwd: process.cwd(),
    startedAt: selfStartedAt(),
    updatedAt: new Date().toISOString(),
    parents: snapshotParents(),
  });
}

/** 就绪后回填端口（CLI / 别的实例据此找到我） */
export function setSelfPort(port: number): void {
  updateRecord(registryDir(), process.pid, { port });
}

/** `/ping` 就绪后回填（远程发现器据此找本机实例；老实例没有这个字段 = 不提供 /ping） */
export function setSelfPingPort(port: number): void {
  updateRecord(registryDir(), process.pid, { pingPort: port });
}

/** 退出清理；**不保证执行**（SIGKILL / 崩溃 / 测试 harness 的 SIGTERM），故读侧另有 pid 存活过滤 */
export function dropSelfRecord(): void {
  removeRecord(registryDir(), process.pid);
}

// ── 本实例自报（`instances.self` 的载荷；也是 `list` / `ls` 探测的目标） ──

/** 本实例自报：身份 + 活跃会话 + 窗口状态（窗口由调用方给的 handler 取，serve 模式为 null） */
export function selfReport(opts: {
  window: InstanceSelf["window"];
  branch: string;
  repoDisplay: string;
}): InstanceSelf {
  const home = state.diyHome();
  const turns: InstanceTurn[] = sessionRegistry.activeTurnList().map((t) => ({
    uri: t.uri,
    since: t.since,
    steps: t.steps,
    ...(t.model ? { model: t.model } : {}),
  }));
  return {
    pid: process.pid,
    port: new AppConfig(home).readPort() ?? 0,
    diyHome: home,
    diyHomeDisplay: homeDisplayOf(home),
    env: process.env["DIY_ENV"] ?? "production",
    variant: process.env["DIY_VARIANT"] ?? "prod",
    branch: opts.branch,
    repoDisplay: opts.repoDisplay,
    startedAt: selfStartedAt(),
    sessions: sessionRegistry.snapshot().length,
    running: turns.length,
    activeTurns: turns,
    window: opts.window,
  };
}

// ── 扫描 + 聚合 ───────────────────────────────────────────────

export interface CollectDeps {
  /** `ps -Ao pid=,ppid=,command=` 的原文 */
  ps?: () => string;
  /** 老实例（无注册表）的环境变量批量取法 —— 只作线索，绝不当作真根 */
  envOf?: (pids: number[]) => Map<number, Record<string, string>>;
  dir?: string;
  /** 存活判定（缺省 = 真查进程表）；注入只为单测能摆桩 */
  alive?: (pid: number) => boolean;
  probeSelf?: (port: number) => Promise<InstanceSelf | null>;
  probeAppInfo?: (port: number) => Promise<AppInfoLite>;
  readPortFile?: (home: string) => number | null;
}

function defaultPs(): string {
  return execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
    encoding: "utf-8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * 批量取环境变量（**一次** `ps eww -p a,b,c`，不是每 pid 一次）。
 * 行格式：`  PID  TT  STAT   TIME  COMMAND ENV=… ENV=…`（`ps eww` 无法抑制表头，跳过非数据行）。
 */
export function psEnvironments(
  pids: number[],
  run: (args: string[]) => string = (a) =>
    execFileSync("ps", a, { encoding: "utf-8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 }),
): Map<number, Record<string, string>> {
  const out = new Map<number, Record<string, string>>();
  if (pids.length === 0) return out;
  let text: string;
  try {
    text = run(["eww", "-p", pids.join(",")]);
  } catch {
    return out; // 取不到就取不到（老实例只是少一条线索），绝不因此让整表失败
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
    if (!m) continue;
    const env: Record<string, string> = {};
    for (const tok of (m[2] ?? "").split(/\s+/)) {
      const eq = tok.indexOf("=");
      if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
    out.set(Number(m[1]), env);
  }
  return out;
}

/** 「谁开的」摘要：父链第一跳的 command；拿不到写「来源未知」（老实例的常态，不藏） */
export function sourceSummary(rec: InstanceRecord | undefined): string {
  if (!rec) return "来源未知";
  if (rec.parents.length === 0) return `pid ${rec.pid}（无父进程记录）`;
  return cmdlineSummary(rec.parents[0]!.command, 56);
}

/** argv 摘要：注册表里有启动时快照就用它（最准），否则退回 ps 的 command */
function argvOf(rec: InstanceRecord | undefined, p: InstanceProcess): string[] {
  return rec && rec.argv.length > 0 ? rec.argv : [p.command];
}

/** 一行实例的**本地事实**部分（不含网络）：注册表 > 进程 > 环境线索 */
function baseRow(
  p: InstanceProcess,
  rec: InstanceRecord | undefined,
  hint: Record<string, string> | undefined,
  readPortFile: (home: string) => number | null,
): InstanceRow {
  const hintHome = hint?.["DIY_HOME"] ?? "";
  const port = rec?.port ?? (hintHome ? readPortFile(hintHome) : null);
  const diyHome = rec?.diyHome ?? "";
  return {
    pid: p.pid,
    kind: p.kind,
    variant: p.variant ?? rec?.variant ?? "",
    diyHome,
    diyHomeDisplay: diyHome ? homeDisplayOf(diyHome) : hintHome ? `${homeDisplayOf(hintHome)}?` : "",
    homeSource: rec ? "registry" : hintHome ? "hint" : "unknown",
    env: rec?.env ?? hint?.["DIY_ENV"] ?? "",
    branch: "",
    repoDisplay: "",
    port,
    source: sourceSummary(rec),
    sourceKind: rec ? "registry" : "unknown",
    cmdline: cmdlineSummary(argvOf(rec, p).join(" ")),
    cwd: rec?.cwd ?? "",
    startedAt: rec?.startedAt ?? null,
    status: port === null ? "no-port" : "unreachable",
    note: rec ? "" : "未注册（本功能上线前启动的实例）：数据根与来源只能靠继承的环境变量猜",
    sessions: 0,
    running: 0,
    activeTurns: [],
    window: null,
  };
}

/** 注册表里有、进程扫描没命中（如 serve 跑源码 `tsx src/serve/index.ts`）→ 用注册表事实成行 */
function recordOnlyRow(rec: InstanceRecord): InstanceRow {
  return {
    pid: rec.pid,
    kind: rec.argv.some((a) => a.includes("/serve/")) ? "serve" : "electron",
    variant: rec.variant,
    diyHome: rec.diyHome,
    diyHomeDisplay: homeDisplayOf(rec.diyHome),
    homeSource: "registry",
    env: rec.env,
    branch: "",
    repoDisplay: "",
    port: rec.port,
    source: sourceSummary(rec),
    sourceKind: "registry",
    cmdline: cmdlineSummary(rec.argv.join(" ")),
    cwd: rec.cwd,
    startedAt: rec.startedAt,
    status: rec.port === null ? "no-port" : "unreachable",
    note: "进程扫描未命中（入口形态非常规），信息来自注册表",
    sessions: 0,
    running: 0,
    activeTurns: [],
    window: null,
  };
}

/**
 * 收全机实例（含**没有注册表的老实例**：看得见就列出来，如实标「来源未知」）。
 *
 * 探测并发 + 单行超时 + 失败降级：`instances.self`（新实例，带会话与窗口）→ `getAppInfo`
 * （老实例，只有身份）→ 都没有则 `unreachable`（**明确区别于 no-port**：那说明端口上有人占着却不答话）。
 */
export async function collectInstances(deps: CollectDeps = {}): Promise<InstanceRow[]> {
  const dir = deps.dir ?? registryDir();
  const psText = (deps.ps ?? defaultPs)();
  const probeSelf = deps.probeSelf ?? ((port: number) => fetchInstanceSelf(port, PROBE_TIMEOUT_MS));
  const probeAppInfo = deps.probeAppInfo ?? ((port: number) => fetchAppInfo(port, PROBE_TIMEOUT_MS));
  const readPortFile = deps.readPortFile ?? ((home: string) => new AppConfig(home).readPort());

  const procs = pickInstanceProcesses(parsePsOutput(psText));
  const records = new Map(readRecords(dir, deps.alive).map((r) => [r.pid, r] as const));
  const needEnv = procs.filter((p) => !records.has(p.pid)).map((p) => p.pid);
  const envs = (deps.envOf ?? psEnvironments)(needEnv);

  const rows = procs.map((p) => baseRow(p, records.get(p.pid), envs.get(p.pid), readPortFile));
  for (const rec of records.values()) {
    if (rows.some((r) => r.pid === rec.pid)) continue;
    rows.push(recordOnlyRow(rec));
  }

  await Promise.all(rows.map((row) => probeRow(row, { probeSelf, probeAppInfo })));
  return rows;
}

/** 追加一句说明（不覆盖已有 —— 「进程扫描未命中」这类结构性提示与探测结论要能同时看到） */
function appendNote(row: InstanceRow, text: string): void {
  row.note = [row.note, text].filter(Boolean).join("；");
}

/** 探测一行并**就地补全**：自报 > 注册表 > hint；探测失败如实降级（绝不把失败写成成功） */
async function probeRow(
  row: InstanceRow,
  deps: {
    probeSelf: (port: number) => Promise<InstanceSelf | null>;
    probeAppInfo: (port: number) => Promise<AppInfoLite>;
  },
): Promise<void> {
  if (row.port === null) {
    row.status = "no-port";
    return;
  }
  const self = await deps.probeSelf(row.port);
  if (self) {
    row.status = "ready";
    row.diyHome = self.diyHome;
    row.diyHomeDisplay = self.diyHomeDisplay || homeDisplayOf(self.diyHome);
    row.homeSource = "self";
    row.env = self.env;
    row.variant = self.variant || row.variant;
    row.branch = self.branch;
    row.repoDisplay = self.repoDisplay;
    row.port = self.port || row.port;
    row.startedAt = self.startedAt || row.startedAt;
    row.sessions = self.sessions;
    row.running = self.running;
    row.activeTurns = self.activeTurns;
    row.window = self.window;
    return; // 已有的结构性提示（如「进程扫描未命中」）保留：那是行的出身，不是这一轮探测的结论
  }
  try {
    const info = await deps.probeAppInfo(row.port);
    row.status = "ready";
    row.diyHome = info.diyHome;
    row.diyHomeDisplay = homeDisplayOf(info.diyHome);
    row.homeSource = "self";
    row.env = info.env;
    if (info.branch) row.branch = info.branch;
    if (info.repoDisplay) row.repoDisplay = info.repoDisplay;
    if (typeof info.port === "number" && info.port > 0) row.port = info.port;
    appendNote(row, "老实例（没有 instances.self）：只有身份，看不到会话与窗口状态");
    return;
  } catch {
    row.status = "unreachable";
    appendNote(row, `端口 ${row.port} 无响应（实例在退出 / 卡死 / 端口已被别人接管）`);
  }
}

/** `diy instances ls` 的载荷：对齐表格文本（人读） */
export async function renderInstanceList(deps: CollectDeps = {}): Promise<string> {
  return renderInstanceTable(await collectInstances(deps));
}

// ── 唤起（focus 跨实例 / reveal 本实例） ────────────────────────

export interface FocusResult {
  pid: number | null;
  port: number | null;
  /** rpc = 目标实例自己 show+focus+全屏；osascript = 系统级降级 */
  via: "rpc" | "osascript";
  reason: string;
}

export interface FocusDeps {
  collect?: () => Promise<InstanceRow[]>;
  reveal?: (port: number) => Promise<{ ok: boolean; reason: string; fullScreen: boolean }>;
  osascript?: (pid: number) => boolean;
}

/**
 * 唤起目标：先 RPC（确定、无需系统权限、由目标实例自己 show+focus+全屏），
 * 失败再 osascript 降级（需 Automation 权限，可能弹窗）；**两路都失败 → 抛错**（不静默吞）。
 */
export async function focusInstance(target: { pid?: number; port?: number }, deps: FocusDeps = {}): Promise<FocusResult> {
  const rows = await (deps.collect ?? (() => collectInstances()))();
  const row =
    target.pid !== undefined ? rows.find((r) => r.pid === target.pid) : rows.find((r) => r.port === target.port);
  if (!row) {
    throw new Error(
      target.pid !== undefined
        ? `找不到实例 pid=${target.pid}（可能已退出；跑 diy instances ls 看当前有哪些）`
        : `找不到实例 port=${target.port}（跑 diy instances ls 看当前有哪些）`,
    );
  }

  const reasons: string[] = [];
  if (row.port !== null) {
    try {
      const res = await (deps.reveal ?? ((port: number) => revealInstance(port)))(row.port);
      if (res.ok) return { pid: row.pid, port: row.port, via: "rpc", reason: res.reason || "已请出窗口" };
      reasons.push(`目标实例拒绝：${res.reason}`);
    } catch (e) {
      reasons.push(`RPC 唤起失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    reasons.push("该实例没有可用的 RPC 端口（未就绪 / 未注册）");
  }

  if (row.kind === "electron" && (deps.osascript ?? osascriptFocus)(row.pid)) {
    return { pid: row.pid, port: row.port, via: "osascript", reason: "已用 osascript 前置（RPC 不可用时的降级）" };
  }
  reasons.push("osascript 降级也失败（需「辅助功能/Automation」权限，或该进程无窗口可前置）");
  throw new Error(`唤起 pid=${row.pid} 失败：\n  - ${reasons.join("\n  - ")}`);
}

/**
 * 降级：让 macOS 把某 pid 的进程置前。
 * 需要「自动化 → System Events」权限（可能弹一次系统授权窗），故只作降级用；失败返回 false（由上层汇总原因）。
 */
export function osascriptFocus(pid: number): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "osascript",
      ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}
