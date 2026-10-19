// src/main/core/instance-table.ts
// 🎯 实例盘的**展示层纯函数**：排序 + 对齐表格文本（`diy instances ls`）。
//
// 为什么单独成模块：表格是给人看的，它的规则（列序、截断、中文宽度、谁排前面）是**可测的契约**，
// 与「怎么发现实例」正交。混进聚合服务里就只能起 Electron 才能验排版。
//
// 为什么不用 `padEnd` 收工：来源/会话列含中文，按 UTF-16 长度补齐会让整列错位半格到一格。
// 故按**显示宽度**（CJK 全角算 2）补齐 —— 见 charWidth。

import type { InstanceRow } from "../../shared/instance-row";

/** 排序：**按数据根聚类**（同一根的实例相邻，便于一眼看出「哪个根上有几个」），组内按 pid 升序；
 *  数据根未知的行排最后（它们是信息最少的一档，不该插在已知根中间）。 */
export function sortInstanceRows(rows: InstanceRow[]): InstanceRow[] {
  return [...rows].sort((a, b) => {
    const ah = a.diyHome || "\uffff";
    const bh = b.diyHome || "\uffff";
    if (ah !== bh) return ah < bh ? -1 : 1;
    return a.pid - b.pid;
  });
}

/** 单字符显示宽度：CJK / 全角标点占 2 格，其余 1 格（粗糙但够用 —— 表格不追求像素级） */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 按显示宽度截断（超出加 `…`） */
export function clipDisplay(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 按显示宽度右补空格 */
export function padDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 一行的可读摘要：端口 / 状态 / 会话 三列都从这里派生，保持「表格只读展示」的定位 */
/** 启动时刻 → `MM-DD HH:mm`（本地）。导出给 UI 实例页用（##367）—— 同一句话只写一处：
 *  表格文本与页面上的时间格式必须一致，复制第二份迟早对不上。 */
export function startedAtShort(iso: string | null): string {
  if (!iso) return "-";
  // ISO（UTC）→ 本地 `MM-DD HH:mm`；手工格式化（不引 Intl，保持纯函数 + 确定性）
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 会话摘要：「3 会话 · 2 跑轮」；完全没自报到 → `-` */
export function sessionSummary(r: InstanceRow): string {
  if (r.status !== "ready") return "-";
  const parts: string[] = [`${r.sessions} 会话`];
  if (r.running > 0) parts.push(`${r.running} 跑轮`);
  return parts.join(" · ");
}

interface Col {
  key: string;
  title: string;
  width: number;
  value: (r: InstanceRow) => string;
}

/** 列序 = 人读顺序：**谁(pid) → 哪来的(来源) → 谁的数据(数据根/变体/环境/分支) → 怎么连(端口/状态) → 在干什么(会话)** */
const COLS: Col[] = [
  { key: "pid", title: "PID", width: 6, value: (r) => String(r.pid) },
  { key: "diyHome", title: "数据根", width: 26, value: (r) => r.diyHomeDisplay || "?" },
  { key: "variant", title: "变体", width: 7, value: (r) => r.variant || "-" },
  { key: "env", title: "环境", width: 12, value: (r) => r.env || "-" },
  { key: "branch", title: "分支", width: 18, value: (r) => (r.branch || "-") + (r.kind === "serve" ? " (serve)" : "") },
  { key: "port", title: "端口", width: 6, value: (r) => (r.port === null ? "-" : String(r.port)) },
  { key: "status", title: "状态", width: 12, value: (r) => r.status },
  { key: "source", title: "来源", width: 34, value: (r) => r.source },
  { key: "sessions", title: "会话", width: 20, value: sessionSummary },
  { key: "startedAt", title: "启动", width: 12, value: (r) => startedAtShort(r.startedAt) },
];

/**
 * 渲染对齐表格。列宽 = 表头与全部单元格里最宽者（**上界**见各列 width），
 * 超宽列按显示宽度截断 —— 表格的行长因此有确定上界，窄终端也不会糊成一团。
 */
export function renderInstanceTable(rows: InstanceRow[]): string {
  const sorted = sortInstanceRows(rows);
  const widths = COLS.map((c) => Math.max(displayWidth(c.title), ...sorted.map((r) => Math.min(displayWidth(c.value(r)), c.width))));
  const header = COLS.map((c, i) => padDisplay(c.title, widths[i]!)).join(" ").trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join(" ");
  const body = sorted.map((r) =>
    COLS.map((c, i) => padDisplay(clipDisplay(c.value(r), c.width), widths[i]!)).join(" ").trimEnd(),
  );
  const lines = [header, sep, ...body];
  const ready = sorted.filter((r) => r.status === "ready").length;
  lines.push("", `共 ${sorted.length} 个实例（${ready} 个可唤起）`);
  for (const r of sorted) {
    if (r.note) lines.push(`[${r.pid}] ${r.note}`);
  }
  return lines.join("\n");
}
