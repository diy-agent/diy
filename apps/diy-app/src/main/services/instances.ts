// src/main/services/instances.ts
// 🎯 实例大盘的聚合层 = **动态发现协议**（##518 定稿）。
//
// 整个「有哪些 diy」由两个协议回答，各管一半：
//   静态（`app.yaml`，见 _diy 的 dev-core）：**能起什么** —— 有哪些工作区、各自几条启动命令。
//     启动前就能读；不需要任何实例存在。
//   动态（本文件）：**此刻跑着什么** —— 实例启动时自报一条记录（`core/instance-registry.ts`），
//     读侧按 pid 存活过滤 + 逐个 /ping 验活。没跑就查不到，跑起来自己登记。
//
// 三条硬规矩（都踩过坑）：
//   1. **不再扫进程**（2026-11-07 用户裁）：进程表只能看出「有个 electron 在跑」，
//      身份（数据根 / worktree / 有没有 source）全靠猜。自报记录才是事实；
//      扫进程那套（`core/instance-scan.ts`）随之退役 —— 少一层 OS 策略依赖，也少一种假象。
//   2. **身份只认三样**：有没有 source（`mode`）× worktree × 数据根。
//      `launch` / `slot` 是**启动配置模版**（lab1 / lab2 不代表任何东西），不进身份。
//   3. **名字由实例自理**：自报 `name` 优先，没有就 `<app>#<pid>`（`shared/instance-row.ts::displayNameOf`）。
//      任何活着的实例因此都有一个能拿去 kill / 查的名字，不需要预先登记、也不需要槽位。
//
// 纯逻辑（分类 / 排序 / 排版）在 core，这里只做 I/O 与编排；网络与目录都可注入。

import { AppConfig } from "../core/app-config";
import { findRepoRoot, homeDisplayOf } from "../core/instance-identity";
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
import { os } from "../os";
import { displayNameOf, type InstanceRow, type InstanceTurn } from "../../shared/instance-row";
import { localISOString } from "@diy-agent/time";

/** 命令行摘要（截断到 maxLen）：注册表里存的是完整 argv，表格/UI 只放得下一行 */
export function cmdlineSummary(command: string, maxLen = 72): string {
  const joined = command.trim();
  if (joined.length <= maxLen) return joined;
  return `${joined.slice(0, maxLen - 1)}…`;
}

/** 本进程的启动时刻（`process.uptime()` 反推 —— 不依赖模块加载时机） */
export function selfStartedAt(): string {
  return localISOString(new Date(Date.now() - process.uptime() * 1000));
}

/** 探测预算：单行最坏 = self 超时 + getAppInfo 超时；各行并发，故整表延迟 ≈ 这个量级 */
const PROBE_TIMEOUT_MS = 1200;

// ── 注册表生命周期（本进程 = 自己那条记录的主人） ─────────────────

/**
 * 手工启动（没有启动器注入的 `DIY_LAUNCH`）时按变体回推 launch id。
 * 只映射 apps/diy-app/app.yaml 里真实存在的两条命令：lab → ./sha.sh lab，prod → ./sha.sh prod。
 */
// 只映射「worktree 内声明过的 launch」：lab → app.yaml 的 lab。
// prod 回推过一次就出过事故（##518）：全局 `diy` 跑的实例 variant=prod、cwd 落在主 worktree，
// 写 launch:"prod" 后被面板当成某 worktree 的 prod launch（点停止会杀掉真生产）。
// 生产实例一律 launch=null，由「数据根是不是 ~/.diy」在面板侧认出来。
const LAUNCH_OF_VARIANT: Record<string, string> = { lab: "lab" };

/**
 * 本实例的自报名字（##518）：`DIY_INSTANCE_NAME` 优先；没有就 null ——
 * 展示侧退化成 `<app>#<pid>`，**不要**拿 launch / slot 当名字（那是配置模版，不是身份）。
 */
export function selfName(): string | null {
  const n = (process.env["DIY_INSTANCE_NAME"] ?? "").trim();
  return n || null;
}

/**
 * 本实例的 launch id：启动器注入优先，否则按变体回推（认不出的变体 ⇒ null）。
 *
 * ⚠️ 它现在**只是元数据**（这人从哪个 app.yaml 条目起的，便于展示），不参与身份判定，
 * 也不参与 UI 归组（##518：归组只按 worktree）。窗口标题仍用它，因为标题是给人看的。
 */
export function selfLaunch(variant: string): string | null {
  return process.env["DIY_LAUNCH"] ?? LAUNCH_OF_VARIANT[variant] ?? null;
}

/** 启动时写自己那一条（父进程链此刻还在 —— 这是唯一的快照时机，见 registry 文件头注） */
export function writeSelfRecord(opts: { diyHome: string; variant: string; env: string }): void {
  writeRecord(registryDir(), {
    pid: process.pid,
    app: "diy-app",
    // dev 启动器按 (worktree, app, launch) 三元组对回静态清单：缺 launch / worktree 就永远显示「未启动」
    //   launch：启动器拉起的直接取 DIY_LAUNCH；手工跑按变体回推（认不出的变体才 null）
    //   worktree：从 cwd 往上找 .git（worktree 里 .git 是文件，只判存在性）
    launch: selfLaunch(opts.variant),
    name: selfName(),
    // 有没有 source 是身份第一刀：打包态（asar）dev 只能观测，源码态可读写
    mode: isPackagedRuntime() ? "packaged" : "source",
    worktree: findRepoRoot(process.cwd()),
    port: null,
    pingPort: null,
    diyHome: opts.diyHome,
    variant: opts.variant,
    env: opts.env,
    argv: [...process.argv],
    cwd: process.cwd(),
    startedAt: selfStartedAt(),
    updatedAt: localISOString(),
    parents: snapshotParents(),
  });
}

/**
 * 本进程是不是打包态（asar 内跑）。懒取 electron 的 `app.isPackaged`：
 * 这个模块在单测 / CLI 场景也会被 import，那时没有 electron 可问，按源码态算。
 */
function isPackagedRuntime(): boolean {
  try {
    // 动态 require：只在真 electron 主进程里存在；打包态下 asar 也在
    const { app } = require("electron") as { app?: { isPackaged?: boolean } };
    return app?.isPackaged === true;
  } catch {
    return false;
  }
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
  dir?: string;
  /** 存活判定（缺省 = 真查进程表）；注入只为单测能摆桩 */
  alive?: (pid: number) => boolean;
  probeSelf?: (port: number) => Promise<InstanceSelf | null>;
  probeAppInfo?: (port: number) => Promise<AppInfoLite>;
  readPortFile?: (home: string) => number | null;
}

/** 「谁开的」摘要：父链第一跳的 command；拿不到写「来源未知」（老实例的常态，不藏） */
export function sourceSummary(rec: InstanceRecord | undefined): string {
  if (!rec) return "来源未知";
  if (rec.parents.length === 0) return `pid ${rec.pid}（无父进程记录）`;
  return cmdlineSummary(rec.parents[0]!.command, 56);
}

/**
 * 一条记录是「有 source」还是「安装包」——**身份第一刀**（##518）。
 *
 * 优先用自报的 `mode`（启动时由 `app.isPackaged` 判定，最准）；老记录没有这个字段时按 argv 猜：
 * 路径里出现 `app.asar` / `Resources/app` ⇒ 打包态；否则按源码态算（错判的代价只是多给个停止按钮，
 * 而真生产是「数据根 = ~/.diy」的另一道闸，见面板的族外实例判定）。
 */
function modeOf(rec: InstanceRecord): "source" | "packaged" {
  if (rec.mode) return rec.mode;
  const joined = rec.argv.join(" ");
  if (joined.includes("app.asar") || joined.includes("/Resources/app")) return "packaged";
  return "source";
}

/** 一条记录 → 一行实例的**本地事实**（不含网络）。发现侧唯一的构造入口。 */
function rowFromRecord(rec: InstanceRecord): InstanceRow {
  const mode = modeOf(rec);
  const worktree = mode === "source" ? (rec.worktree ?? "") : "";
  return {
    pid: rec.pid,
    kind: rec.argv.some((a) => a.includes("/serve/")) ? "serve" : "electron",
    mode,
    worktree,
    worktreeDisplay: worktree ? homeDisplayOf(worktree) : "",
    name: rec.name ?? "",
    displayName: displayNameOf({ pid: rec.pid, name: rec.name ?? "", app: rec.app ?? "" }),
    variant: rec.variant,
    diyHome: rec.diyHome,
    diyHomeDisplay: homeDisplayOf(rec.diyHome),
    homeSource: "registry",
    env: rec.env,
    branch: "",
    repoDisplay: worktree ? homeDisplayOf(worktree) : "",
    port: rec.port,
    source: sourceSummary(rec),
    sourceKind: "registry",
    cmdline: cmdlineSummary(rec.argv.join(" ")),
    cwd: rec.cwd,
    startedAt: rec.startedAt,
    status: rec.port === null ? "no-port" : "unreachable",
    note: "",
    sessions: 0,
    running: 0,
    activeTurns: [],
    window: null,
  };
}

/**
 * 收全机实例：**只读动态注册表**（不再扫进程，见文件头第 1 条）。
 *
 * 每条都发一次自报探测：`instances.self`（新实例，带会话与窗口）→ `getAppInfo`（老实例，只有身份）
 * → 都失败则 `unreachable`（**明确区别于 no-port**：那说明端口上有人占着却不答话）。
 *
 * 注册表里被 SIGKILL 留下的死记录由 pid 存活过滤挡掉（读侧的兜底，写侧的清理不保证执行）。
 */
export async function collectInstances(deps: CollectDeps = {}): Promise<InstanceRow[]> {
  const dir = deps.dir ?? registryDir();
  const probeSelf = deps.probeSelf ?? ((port: number) => fetchInstanceSelf(port, PROBE_TIMEOUT_MS));
  const probeAppInfo = deps.probeAppInfo ?? ((port: number) => fetchAppInfo(port, PROBE_TIMEOUT_MS));
  const readPortFile = deps.readPortFile ?? ((home: string) => new AppConfig(home).readPort());

  const rows = readRecords(dir, deps.alive).map((rec) => {
    const row = rowFromRecord(rec);
    // 记录写了 port，但端口可能还没就绪（启动早期那份）→ 退回数据根的 app.port 文件
    if (row.port === null) row.port = readPortFile(rec.diyHome);
    return row;
  });

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
  /** rpc = 目标实例自己 show+focus+全屏；system = 系统级降级（实现由 os 策略给） */
  via: "rpc" | "system";
  reason: string;
}

export interface FocusDeps {
  collect?: () => Promise<InstanceRow[]>;
  reveal?: (port: number) => Promise<{ ok: boolean; reason: string; fullScreen: boolean }>;
  /** 系统级前置（缺省 `os.focusProcess`；注入只为单测） */
  focus?: (pid: number) => boolean;
}

/**
 * 唤起目标：先 RPC（确定、无需系统权限、由目标实例自己 show+focus+全屏），
 * 失败再走系统级降级（macOS = osascript；其他平台由策略声明不支持）；**两路都失败 → 抛错**（不静默吞）。
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

  if (row.kind === "electron" && (deps.focus ?? ((pid: number) => os.focusProcess(pid)))(row.pid)) {
    return { pid: row.pid, port: row.port, via: "system", reason: "已用系统级唤起前置（RPC 不可用时的降级）" };
  }
  reasons.push("系统级降级也失败（平台不支持，或需「辅助功能/Automation」权限 / 该进程无窗口可前置）");
  throw new Error(`唤起 pid=${row.pid} 失败：\n  - ${reasons.join("\n  - ")}`);
}
