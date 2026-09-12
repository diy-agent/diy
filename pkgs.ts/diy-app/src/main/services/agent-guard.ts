// src/main/services/agent-guard.ts
// 🎯 本地 agent 的 bash 自杀护栏：执行前判定"这条命令会不会把 diy 自己干掉"
//
// 背景（2026-09-12 实测复现，任务 projects/4/tasks/92）：
//   agent 想"清理多余的 Electron 实例"，于是反复执行
//     ps aux | grep Electron | ... | xargs kill -9
//     pkill -9 -f electron
//   结果把宿主自己的 GPU / NetworkService / Renderer 子进程杀掉
//   （main.log: [crash] 子进程消亡 reason=killed exitCode=9），渲染进程不再重建
//   → 窗口白屏（用户感知的"app 挂了"）。主进程侥幸存活，因此**没有 minidump**，
//   也没有任何"谁干的"因果日志。
//
// 关键认识：SIGKILL 无法被捕获，事后补救不可能 —— 只能在执行前拦截（本文件）
// 并在执行前落盘审计（agent-audit.ts，write-ahead log）。
//
// 本文件只放纯逻辑 + 一次 ps 采样，便于单测。

import { execFileSync } from "node:child_process";

export interface SelfProcessInfo {
  /** 自身 pid */
  pid: number;
  /** 自身进程组 */
  pgid: number;
  /** 与自身同生共死的 pid 集合：祖先链 + 直接子进程 + 同进程组 + diy 进程全家 */
  pids: Set<number>;
  /** 上述进程的命令行（已转小写，用于 pattern 命中判定） */
  cmdlines: string[];
}

export interface KillVerdict {
  blocked: boolean;
  /** 拦截原因（面向模型/日志，中文） */
  reason: string;
}

const PASS: KillVerdict = { blocked: false, reason: "" };

/** 只看"杀进程"语义；纯查询（pgrep/ps）不能命中 */
const KILL_WORD = /\b(?:kill|pkill|killall)\b/;
/** 命令级分隔（保留管道：`grep x | xargs kill` 必须视为同一段） */
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\n|&)\s*/;
/** 杀进程语句片段：`kill/pkill/killall` 到下一个命令分隔符 */
const KILL_SEGMENT = /(?:^|[\s;|&(])(?:kill|pkill|killall)\b([^;|&\n]*)/g;
/** 候选目标：引号串或长度 ≥3 的裸词 */
const CANDIDATE = /"[^"]*"|'[^']*'|[A-Za-z0-9_./:@-]{3,}/g;
/** 命令里的 diy/Electron 自指特征（命中即危险） */
const HOST_MARKER = /electron|\.diy\b|out\/main\/index\.mjs|electron_user_data/i;
/** 常见 shell 词，参与匹配只会造成误伤 */
const STOP = new Set([
  "kill",
  "pkill",
  "killall",
  "grep",
  "pgrep",
  "xargs",
  "awk",
  "print",
  "echo",
  "sleep",
  "head",
  "tail",
  "wc",
  "ps",
  "aux",
  "ef",
  "bash",
  "sh",
  "null",
  "dev",
  "then",
  "else",
  "done",
  "true",
  "false",
  "sort",
  "uniq",
  "sed",
  "xargs",
  "sudo",
  "the",
  "and",
  "for",
]);

function normalizeWord(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim().toLowerCase();
}

/**
 * 归一化命令的“反 grep 自身”写法：`grep -E "[E]lectron"` 等价于匹配 `Electron`。
 * 不还原的话，HOST_MARKER 会漏掉这类变体（实测被 agent 用过）。
 */
export function normalizeCommand(command: string): string {
  return command.replace(/\[([A-Za-z])\]/g, "$1");
}

/** 排除选项、设备路径等噪声候选 */
function isNoise(w: string): boolean {
  if (w.startsWith("-")) return true;
  if (w.startsWith("/dev/")) return true;
  if (w.startsWith("/proc/")) return true;
  return false;
}

/** 从命令里抽取"可能是杀进程目标"的候选词 */
export function killTargetCandidates(command: string): string[] {
  const out = new Set<string>();
  for (const m of normalizeCommand(command).matchAll(CANDIDATE)) {
    const w = normalizeWord(m[0]);
    if (w.length < 3) continue;
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (isNoise(w)) continue;
    out.add(w);
  }
  return [...out];
}

/**
 * 切出"含杀进程操作"的命令段。
 * 为什么要切：`kill -9 10048; ps aux | grep electron | wc -l` 里 electron 只属于后面的查询，
 * 不切就会误拦（实测过）。管道不切，因为 `grep electron | xargs kill` 本身就是一条自杀链。
 */
export function killSegments(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .filter((s) => KILL_WORD.test(s));
}

/**
 * 判定命令是否会杀死 diy 自身。
 * 保守优先：拿不准就拦（自杀的代价是白屏 + 无日志，误拦只是让模型换个做法）。
 */
export function judgeSelfKill(command: string, self: SelfProcessInfo): KillVerdict {
  const segments = killSegments(command);
  if (segments.length === 0) return PASS;

  for (const seg of segments) {
    // 规则 1：显式 pid / -pgid 命中自身进程集合
    const hits: number[] = [];
    for (const m of seg.matchAll(KILL_SEGMENT)) {
      const body = m[1] ?? "";
      for (const t of body.matchAll(/(?<![\w.-])(\d{2,})(?![\w.])/g)) {
        const n = Number(t[1]);
        if (self.pids.has(n)) hits.push(n);
      }
      for (const t of body.matchAll(/(?:^|\s)-(\d{2,})(?=\s|$)/g)) {
        if (Number(t[1]) === self.pgid) hits.push(Number(t[1]));
      }
    }
    if (hits.length > 0) {
      return {
        blocked: true,
        reason: `命令里的 pid 属于 diy 自身进程树（${[...new Set(hits)].join(", ")}；自身 pid=${self.pid}，pgid=${self.pgid}）`,
      };
    }

    // 规则 2：本段带 diy/Electron 自指特征 → 直接拦（覆盖 pkill -f electron / grep Electron | xargs kill）
    if (HOST_MARKER.test(normalizeCommand(seg))) {
      return {
        blocked: true,
        reason: "这条命令同时出现 kill 与 Electron/diy 特征（会波及宿主自身进程树）",
      };
    }

    // 规则 3：pattern 命中自身命令行
    const selfCmd = self.cmdlines.join("\n");
    const matched = killTargetCandidates(seg).filter((w) => selfCmd.includes(w));
    if (matched.length > 0) {
      return {
        blocked: true,
        reason: `杀进程目标 pattern 命中 diy 自身命令行: ${matched.join(", ")}`,
      };
    }

    // 规则 4：pkill/killall 没有任何可判定的目标 → 无法证明安全，拦
    if (/\b(?:pkill|killall)\b/.test(seg)) {
      const hasPidTarget = /(?<![\w.-])\d{2,}(?![\w.])/.test(seg);
      if (!hasPidTarget) {
        return {
          blocked: true,
          reason: "pkill/killall 目标无法静态判定，可能波及 diy 自身进程",
        };
      }
    }
  }

  return PASS;
}

/** 拦截时回给模型的说明（要能指导它换正确做法，否则模型会反复重试） */
export function selfKillNotice(verdict: KillVerdict): string {
  return [
    "[已拦截] 该命令可能杀死 diy 自身进程，未执行。",
    `原因：${verdict.reason}`,
    "diy 的界面（renderer/GPU/network 子进程）与本地 agent 都跑在同一个 Electron 进程树里，",
    "杀掉它们等于自杀：窗口白屏、进程被 SIGKILL 不留 minidump。",
    "正确做法：",
    "  1) 只做查询（ps/pgrep 不加 kill）确认现状；",
    "  2) 确实要清理别的进程时，用精确 pid 且先核对不是自身进程树；",
    "  3) 重启 diy 交给用户手动执行（终端里跑 diy doctor / 重启图标），不要在 agent 里杀进程。",
  ].join("\n");
}

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

function parsePsLine(line: string): PsRow | null {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] ?? "" };
}

/**
 * 采样自身进程信息。失败返回 null —— 调用方应退化为放行（护栏不能阻断正常开发）。
 * 判据（四类"同生共死"进程）：
 *   a) 自身 + 祖先链        —— 杀它等于杀自己
 *   b) 直接子进程           —— Electron helper（GPU/network/renderer/crashpad）
 *   c) 同进程组             —— kill -<pgid> 会波及
 *   d) diy 进程全家         —— 命令行提到 DIY_HOME / out/main/index.mjs 的（crashpad 的 ppid 是 1，靠这条兜住）
 */
export function collectSelfInfo(home: string): SelfProcessInfo | null {
  try {
    const raw = execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,command="], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows = raw.split("\n").map(parsePsLine).filter((r): r is PsRow => r !== null);
    const byPid = new Map(rows.map((r) => [r.pid, r]));

    const pids = new Set<number>([process.pid]);
    let cur = byPid.get(process.pid);
    while (cur && cur.ppid > 1) {
      pids.add(cur.ppid);
      cur = byPid.get(cur.ppid);
    }
    const pgid = byPid.get(process.pid)?.pgid ?? process.pid;
    const markers = [home, `${home}/electron_user_data`, "out/main/index.mjs"];
    for (const r of rows) {
      if (r.pgid === pgid) pids.add(r.pid);
      if (r.ppid === process.pid) pids.add(r.pid);
      if (markers.some((m) => m && r.command.includes(m))) pids.add(r.pid);
    }

    const cmdlines = rows.filter((r) => pids.has(r.pid)).map((r) => r.command.toLowerCase());
    cmdlines.push(process.argv.join(" ").toLowerCase(), process.execPath.toLowerCase());
    return { pid: process.pid, pgid, pids, cmdlines };
  } catch {
    return null;
  }
}
