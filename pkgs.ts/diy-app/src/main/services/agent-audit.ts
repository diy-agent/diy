// src/main/services/agent-audit.ts
// 🎯 本地 agent 执行审计（write-ahead log）：任何死法都能查到最后发生了什么
//
// 为什么不能"事后记录"：agent 的 bash 工具能杀掉宿主进程（kill -9），
// 主进程被 SIGKILL 时 JS 一行代码都跑不到 —— 事后日志必然缺最后一幕。
// 所以每次执行**之前**先落盘：谁（taskUri/model）、哪条命令、什么 cwd。
//
// 文件：<DIY_HOME>/log/agent-bash.jsonl（每行一条 JSON，append-only，超 5MB 轮转一份 .1）
// 用法：
//   appendAudit(home, {...})        执行前/后各写一条
//   crashContext(home)              崩溃日志里附上"最近一幕"（由 crash-reporting 调用）
//
// 注意：appendFileSync 走 write(2)，数据进内核页缓存即可跨进程死亡存活
// （只有断电/系统崩溃才会丢），对 SIGKILL 场景足够。

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export type AuditPhase = "turn-start" | "turn-end" | "bash-start" | "bash-end" | "bash-blocked";

export interface AuditEntry {
  /** ISO 时间戳 */
  ts: string;
  phase: AuditPhase;
  /** 写入者进程 pid（主进程 = app pid） */
  pid: number;
  taskUri?: string;
  model?: string;
  cwd?: string;
  /** 完整命令（bash 类） */
  command?: string;
  /** 耗时 ms（bash-end） */
  ms?: number;
  /** 结果摘要，截断（bash-end/拦截原因） */
  result?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const TAIL_BYTES = 128 * 1024;

export function auditFile(home: string): string {
  return join(home, "log", "agent-bash.jsonl");
}

/** 追加一条审计（同步 + 自动轮转）。失败不影响主流程，但要出声。 */
export function appendAudit(home: string, entry: Omit<AuditEntry, "ts" | "pid"> & { ts?: string }): void {
  try {
    const p = auditFile(home);
    mkdirSync(join(home, "log"), { recursive: true });
    try {
      if (statSync(p).size > MAX_BYTES) renameSync(p, `${p}.1`);
    } catch {
      /* 首次写入或轮转失败都无所谓 */
    }
    const row: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), pid: process.pid, ...entry };
    appendFileSync(p, `${JSON.stringify(row)}\n`, "utf-8");
  } catch (e) {
    console.warn("[agent-audit] 审计写入失败:", e);
  }
}

/** 读文件尾部的审计条目（丢弃可能被截断的首行） */
export function tailAudit(home: string, n = 20): AuditEntry[] {
  const p = auditFile(home);
  if (!existsSync(p)) return [];
  try {
    const size = statSync(p).size;
    const len = Math.min(size, TAIL_BYTES);
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
    if (len < size && lines.length > 0) lines.shift(); // 首行大概率截断
    const out: AuditEntry[] = [];
    for (const l of lines.slice(-n)) {
      try {
        out.push(JSON.parse(l) as AuditEntry);
      } catch {
        /* 半行忽略 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 崩溃现场一行摘要：最近一轮任务 + 最近一条命令。
 * 供 child-process-gone / render-process-gone / 退出钩子直接附在日志里。
 */
export function crashContext(home: string): string {
  const rows = tailAudit(home, 40);
  if (rows.length === 0) return "无 agent 审计记录";
  const lastTurn = [...rows].reverse().find((r) => r.phase === "turn-start");
  const lastCmd = [...rows].reverse().find((r) => r.phase === "bash-start" || r.phase === "bash-blocked" || r.phase === "bash-end");
  const parts: string[] = [];
  if (lastTurn) parts.push(`轮次 task=${lastTurn.taskUri ?? "?"} model=${lastTurn.model ?? "?"} 起始=${lastTurn.ts}`);
  if (lastCmd) {
    const cmd = (lastCmd.command ?? "").replace(/\s+/g, " ").slice(0, 300);
    parts.push(`最近命令[${lastCmd.phase}] ${lastCmd.ts} cwd=${lastCmd.cwd ?? "?"} :: ${cmd}`);
  }
  return parts.join(" | ") || `${rows.length} 条审计但无轮次/命令`;
}
