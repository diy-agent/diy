// src/shared/instance-view.ts
// 🎯 实例页（导航「实例」，##367）的**展示语义** —— 纯函数，renderer 与单测共用一份。
//
// 为什么单独成模块（##329 R1 的教训）：这些是**可判定的语义**——
//   能唤起吗（`focusReadiness`）/ 这一行怎么读（列定义）/ 谁排前面（`sortRowsForUi`）/
//   这一刻该不该发下一次轮询（`decidePoll`）/ 刷新后选中怎么留（`keepPid`）。
// 埋在组件里就只能起 Electron 靠截图看（那是"验证"，不是"回归"）。
//
// 口径：列与文案**对齐** `diy instances ls`（排版真源 `main/core/instance-table.ts`）——
// 同一个实例在表格文本与页面上说的是同一句话，不另立一套措辞（复用它的两个格式化函数，
// 不复制一份：复制出去的第 2 份迟早与第 1 份说不到一块去）。
import type { InstanceRow } from "./instance-row";
import { sessionSummary, sortInstanceRows, startedAtShort } from "../main/core/instance-table";

// ── 列（表头 + 单元格文本） ───────────────────────────────────────

/** 任务号的解析结果（renderer 从 taskStore 查；别的数据根上的任务查不到 → null） */
export interface TaskRef {
  num: string | null;
  title: string | null;
}

/** 列取值时的外部依赖（可注入 → 纯函数可单测） */
export interface InstanceViewCtx {
  /** 任务号 / 标题解析：查不到返回 null（本实例的任务树里没有那个任务） */
  taskOf?: (uri: string) => TaskRef | null;
}

export interface InstanceColumn {
  key: string;
  title: string;
  /** 单元格文本（row → 文本） */
  text: (row: InstanceRow, ctx: InstanceViewCtx) => string;
  /** 单元格悬停说明（"这一格为什么这么显示"） */
  tip: (row: InstanceRow, ctx: InstanceViewCtx) => string;
  /** 表头悬停说明（静态：表头没有"某一行"这个上下文 —— tip 要 row 就没法用在表头上） */
  headTip: string;
  /** 表头可点排序 */
  sortable: boolean;
  /** 单元格附加 class：**长文本列必须截断**（否则整表被撑得比窗口宽，"操作"列跑到屏幕外） */
  cellClass?: string;
  /** 需要 mono 字体（pid / 端口 / 分支 这类标识符） */
  mono: boolean;
}

/** URI 末段的 `tasks/<n>` → `n`（别的数据根上的任务只有这个可读） */
function numFromUri(uri: string): string | null {
  const m = /\/tasks\/(\d+)\/?$/.exec(uri);
  return m ? m[1]! : null;
}

/** 一个任务的一行人话：`#367 实例大盘`；只有号就 `#367`；都没有 → 原 uri（不装懂） */
export function taskLabel(uri: string, ctx: InstanceViewCtx): string {
  const hit = ctx.taskOf?.(uri) ?? null;
  const num = hit?.num ?? numFromUri(uri);
  const title = hit?.title ?? null;
  if (num && title) return `#${num} ${title}`;
  if (num) return `#${num}`;
  return uri;
}

/** 最多列几个在跑的任务（再多就折成 `+N`；表格要能一眼看完，不是日志） */
export const ACTIVE_TASK_SHOWN = 2;

/** 在跑的任务列：`#367 实例大盘、#366 …`；一个都没有 → `—` */
export function activeTasksLabel(row: InstanceRow, ctx: InstanceViewCtx): string {
  if (row.activeTurns.length === 0) return "—";
  const shown = row.activeTurns.slice(0, ACTIVE_TASK_SHOWN).map((t) => taskLabel(t.uri, ctx));
  const rest = row.activeTurns.length - shown.length;
  return rest > 0 ? `${shown.join("、")} +${rest}` : shown.join("、");
}

/** 状态 → 人话 + 色调（色调只给 UI 上色，判据仍是 `status` 原值） */
export type InstanceTone = "ok" | "warn" | "err" | "ghost";

/** 色调 → 文本色 class（只影响观感；判据永远是 `status` 原值） */
export const INSTANCE_TONE_CLASS: Record<InstanceTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  err: "text-error",
  ghost: "opacity-60",
};

export function statusView(status: string): { label: string; tone: InstanceTone; tip: string } {
  switch (status) {
    case "ready":
      return { label: "就绪", tone: "ok", tip: "活体探测通过（instances.self / getAppInfo 有响应）" };
    case "no-port":
      return { label: "无端口", tone: "warn", tip: "还没有 RPC 端口（未就绪 / 未注册）—— 只能走系统级唤起" };
    case "unreachable":
      return {
        label: "无响应",
        tone: "err",
        tip: "端口上有人占着却不答话（实例在退出 / 卡死 / 端口已被别人接管）",
      };
    case "unregistered":
      return { label: "未注册", tone: "ghost", tip: "注册表里没有它（本功能上线前启动的老实例）" };
    default:
      return { label: status || "未知", tone: "ghost", tip: "服务端给出的未知状态（原样显示，不猜）" };
  }
}

/** 数据根列：自报的是真根，hint / 未知只是线索 —— 线索加 `?`，与 CLI 表格同一套记号 */
export function homeLabel(row: InstanceRow): string {
  return row.diyHomeDisplay || "?";
}

/** 数据根列的解释（`homeSource` 是本页最容易被误读的一格，必须说清哪来的） */
export function homeTip(row: InstanceRow): string {
  switch (row.homeSource) {
    case "self":
      return `实例自己报的数据根（可信）：${row.diyHome}`;
    case "registry":
      return `来自启动注册表：${row.diyHome}（进程扫描未命中，未自报）`;
    case "hint":
      return `只是线索：来自进程环境变量 ${row.diyHome}（环境变量是**继承**来的，不等于真数据根）`;
    default:
      return "数据根未知（既没自报、也没注册表、也没有环境线索）";
  }
}

/** 来源列：launchd 接管后的实例追不出父链，注册表也没有 → 如实说"来源未知" */
export function sourceLabel(row: InstanceRow): string {
  if (row.source) return row.source;
  return row.sourceKind === "registry" ? "（注册表未记来源）" : "来源未知";
}

/** 发起唤起前的**可行性判据**（`ok=false` 时按钮禁用并说明原因，不是点了才报错） */
export function focusReadiness(row: InstanceRow): { ok: boolean; reason: string } {
  if (row.port === null && row.kind !== "electron") {
    return { ok: false, reason: "该实例没有 RPC 端口，也不是 Electron（没有窗口可唤起）" };
  }
  if (row.port === null) {
    return { ok: true, reason: "无 RPC 端口 → 只能走 osascript 系统级唤起（需要自动化权限，可能弹系统授权窗）" };
  }
  if (row.status !== "ready") {
    return { ok: true, reason: `RPC 未答话（status=${row.status}）→ 多半会降级到 osascript，可能失败` };
  }
  if (row.window?.fullScreen) {
    return { ok: true, reason: "目标窗口当前已是全屏 —— 唤起只会把它前置" };
  }
  return { ok: true, reason: "由目标实例自己 show + focus + 全屏（不需要系统权限）" };
}

// ── 排序 ─────────────────────────────────────────────────────────

export type InstanceSortKey = "home" | "pid" | "status" | "started" | "variant";
export type SortDir = "asc" | "desc";
export interface InstanceSort {
  key: InstanceSortKey;
  dir: SortDir;
}

/** 缺省排序 = CLI 的排序（按数据根聚类），同一份数据在 CLI 与页面上顺序一致 */
export const DEFAULT_INSTANCE_SORT: InstanceSort = { key: "home", dir: "asc" };

/** 状态严重度（越小越"该先看"）：故障在前，健康在后 */
export function statusSeverity(status: string): number {
  switch (status) {
    case "unreachable":
      return 0;
    case "no-port":
      return 1;
    case "unregistered":
      return 2;
    case "ready":
      return 3;
    default:
      return 4;
  }
}

/** 按指定键排序（不改原数组；`home` 键复用 CLI 的 `sortInstanceRows`，避免两套聚类规则） */
export function sortRowsForUi(rows: InstanceRow[], sort: InstanceSort): InstanceRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  if (sort.key === "home") {
    const out = sortInstanceRows(rows);
    return sort.dir === "asc" ? out : out.reverse();
  }
  const out = [...rows];
  out.sort((a, b) => {
    let d = 0;
    switch (sort.key) {
      case "pid":
        d = a.pid - b.pid;
        break;
      case "status":
        d = statusSeverity(a.status) - statusSeverity(b.status);
        break;
      case "variant":
        d = (a.variant || "").localeCompare(b.variant || "");
        break;
      case "started": {
        // 没有启动时刻的恒排最后（升序降序都一样）：它不是"最早/最晚"，是**不知道**
        const at = a.startedAt ? Date.parse(a.startedAt) : NaN;
        const bt = b.startedAt ? Date.parse(b.startedAt) : NaN;
        const aNull = Number.isNaN(at);
        const bNull = Number.isNaN(bt);
        if (aNull && bNull) d = 0;
        else if (aNull) return 1;
        else if (bNull) return -1;
        else d = at - bt;
        break;
      }
      default:
        d = 0;
    }
    if (d !== 0) return d * sign;
    return a.pid - b.pid; // 同键稳定：永远以 pid 收口，刷新前后不会自己换位
  });
  return out;
}

/** 点表头：同一列 → 翻方向；换列 → 回到该列的缺省方向（数据根升序 = CLI 序，其余降序） */
export function nextSort(cur: InstanceSort, key: InstanceSortKey): InstanceSort {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "home" ? "asc" : "desc" };
}

// ── 选中 / 展开：刷新后怎么留 ─────────────────────────────────────

/**
 * 刷新后保留的 pid：还在这批行里就保留，没了就清空。
 *
 * 这是「刷新不得打断用户当前操作」的**唯一判据** —— 选中/展开都存 pid（不是行对象、
 * 不是行下标）：轮询每次都会换一批**新对象**，按下标留会把选中悄悄挪到别人身上。
 */
export function keepPid(prev: number | null, rows: InstanceRow[]): number | null {
  if (prev === null) return null;
  return rows.some((r) => r.pid === prev) ? prev : null;
}

// ── 轮询 ────────────────────────────────────────────────────────

/** 轮询间隔（ms）：实例的来去不快于秒级，3s 足够"一个周期内消失"，也不至于一直扫 ps */
export const INSTANCE_POLL_MS = 3000;
/** 决策节拍（ms）：真正的"发不发"由 `decidePoll` 判，定时器只负责问它 */
export const INSTANCE_POLL_TICK_MS = 500;

export interface PollInput {
  /** 页面是不是可见（`document.visibilityState === "visible"`） */
  visible: boolean;
  /** 上一轮刷新还在飞 */
  inFlight: boolean;
  /** 现在（ms） */
  now: number;
  /** 上一次**成功结束**的时刻（从未 → null） */
  lastDoneAt: number | null;
  /** 间隔（ms） */
  intervalMs: number;
}

export type PollDecision =
  | { action: "poll" }
  | { action: "wait"; waitMs: number }
  | { action: "pause"; reason: string };

/**
 * 这一刻该不该发下一次刷新。
 *
 * 三条规则（每条都有"不做会怎样"的实测理由）：
 *   ① **页面不可见 → 停**（不是"慢一点"）：隐藏的窗口没人看，扫 ps + 跨实例探测是纯浪费；
 *   ② 上一轮还在飞 → 等（探测预算单行 ~1.2s，并发堆积会把 ps 打满）；
 *   ③ 距上次结束不足间隔 → 等剩下的时间（节拍器 500ms ≠ 轮询 3s）。
 * 注意：**首屏不受 ① 约束** —— 组件挂载时无条件拉一次（`lastDoneAt === null` 时就 poll），
 * 否则"后台标签页里打开实例页"会永远空着。
 */
export function decidePoll(i: PollInput): PollDecision {
  if (i.lastDoneAt === null) return { action: "poll" };
  if (i.inFlight) return { action: "wait", waitMs: i.intervalMs };
  if (!i.visible) return { action: "pause", reason: "页面不可见" };
  const elapsed = i.now - i.lastDoneAt;
  if (elapsed >= i.intervalMs) return { action: "poll" };
  return { action: "wait", waitMs: i.intervalMs - elapsed };
}

// ── 列清单（表头顺序 = 人读顺序） ─────────────────────────────────

/**
 * 列序 = `diy instances ls` 的口径（人读顺序）：
 * **谁(pid) → 哪来的(来源) → 谁的数据(数据根/变体/环境/分支) → 怎么连(端口/状态) → 在干什么(任务/会话) → 什么时候起的**。
 * ⚠️ 与任务页的区别（避免"看着像任务"）：本表**没有状态列以外的任务语义**，
 * 不显示任务状态、不显示任务树层级 —— 这里的"状态"永远是**实例**的状态。
 */
export const INSTANCE_COLUMNS: InstanceColumn[] = [
  { key: "pid", title: "PID", text: (r) => String(r.pid), tip: (r) => `实例主进程 pid=${r.pid}（一个实例 4~5 个进程，只有主进程算一行）`, headTip: "实例主进程 pid（一个实例 4~5 个进程，只有主进程算一行）", sortable: true, mono: true },
  { key: "source", title: "来源", text: (r) => sourceLabel(r), tip: (r) => (r.sourceKind === "registry" ? "启动时快照的父进程链（事后追不出来）" : "没有注册表记录，追不出谁开的"), headTip: "谁开的：启动瞬间快照的父进程链（老实例追不出，如实写「来源未知」）", cellClass: "max-w-[16rem] truncate", sortable: false, mono: false },
  { key: "home", title: "数据根", text: (r) => homeLabel(r), tip: (r) => homeTip(r), headTip: "数据根：只有实例自报的才算真根（环境变量是继承来的，加 ? 表示只是线索）", cellClass: "max-w-[16rem] truncate", sortable: true, mono: true },
  { key: "variant", title: "变体", text: (r) => r.variant || "—", tip: (r) => `产物变体 ${r.variant || "(未知)"}（build/<变体>/ 与数据根同轴）`, headTip: "产物变体：build/<变体>/ 与数据根同轴", sortable: true, mono: true },
  { key: "env", title: "环境", text: (r) => r.env || "—", tip: (r) => `DIY_ENV=${r.env || "(未知)"}`, headTip: "运行环境（DIY_ENV）", sortable: false, mono: false },
  { key: "branch", title: "分支", text: (r) => (r.branch || "—") + (r.kind === "serve" ? " (serve)" : ""), tip: (r) => `${r.repoDisplay || "仓库未知"}${r.branch ? ` @ ${r.branch}` : ""}`, headTip: "当前代码所在 git 分支与仓库", cellClass: "max-w-[12rem] truncate", sortable: false, mono: true },
  { key: "port", title: "端口", text: (r) => (r.port === null ? "—" : String(r.port)), tip: (r) => (r.port === null ? "还没有 RPC 端口" : `RPC 端口 ${r.port}（CLI 打给它的入口）`), headTip: "RPC 端口：CLI 打给它的入口", sortable: false, mono: true },
  { key: "status", title: "状态", text: (r) => statusView(r.status).label, tip: (r) => statusView(r.status).tip, headTip: "实例状态（就绪 / 无端口 / 无响应 / 未注册）", sortable: true, mono: false },
  { key: "task", title: "当前任务", text: activeTasksLabel, tip: (r) => (r.activeTurns.length === 0 ? "此刻没有在跑的轮次" : r.activeTurns.map((t) => `${t.uri}（${t.steps} 步）`).join("\n")), headTip: "此刻在跑的轮次属于哪个任务", cellClass: "max-w-[18rem] truncate", sortable: false, mono: false },
  { key: "session", title: "当前会话", text: (r) => sessionSummary(r), tip: (r) => (r.status === "ready" ? `本次启动后活跃过 ${r.sessions} 个会话，此刻 ${r.running} 个在跑` : "实例未自报 → 会话数不可知（不是 0）"), headTip: "本次启动后活跃过的会话数 + 此刻在跑的轮次数", cellClass: "max-w-[10rem] truncate", sortable: false, mono: false },
  { key: "started", title: "启动", text: (r) => startedAtShort(r.startedAt), tip: (r) => (r.startedAt ? `启动于 ${r.startedAt}` : "启动时刻未知（老实例，注册表里没有它）"), headTip: "实例启动时刻（老实例没有注册表记录 → 显示 -）", sortable: true, mono: true },
];

/** 表头汇总：`共 N 个实例（M 个可唤起）` —— 与 CLI 表格末行同一句话 */
export function summarizeRows(rows: InstanceRow[]): { total: number; focusable: number } {
  return { total: rows.length, focusable: rows.filter((r) => focusReadiness(r).ok).length };
}
