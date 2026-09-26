// src/main/core/single-instance.ts
// 🎯 单实例锁诊断（纯函数，main 与 dev 编排共用；读 Electron 留在 userData 下的锁文件）
//
// 为什么需要：关窗后进程常驻（见 main/index.ts 的 window-all-closed 注释）之后，
// 「锁被一个看不见的实例占着」成了常态。dev 与 CLI 撞锁时的表现都是**沉默失败**：
//   · ./sha.sh dev → 子进程打印 `SingleInstanceLock: failed` 后 exit 0，
//     dev 收尾成 `electron exited, shutting down...`，不说明原因（实测 dev.jsonl）
//   · CLI → 30 秒「启动超时」，对陈旧锁 / 活实例占锁 / 构建缺失一视同仁
// 这里给出「锁在哪、谁占着、是死是活」的判断与文案，把排查从猜变成读。
// 实测锁定的经验：三种处境（活占锁 / 陈旧锁 / 无锁）必须给不同下一步。

import { lstatSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/** Chromium 单实例锁在 userData 下的 symlink 名（requestSingleInstanceLock 创建） */
export const SINGLETON_LOCK = "SingletonLock";

export interface LockInfo {
  /** 锁文件路径 */
  path: string;
  /** 存在但不是 symlink（异常形态） */
  unreadable: boolean;
  /** 持有者（link 目标形如 `hostname-pid`；解析不出 = null） */
  holderPid: number | null;
  /** link 目标原样（无 symlink 时为 null） */
  raw: string | null;
  /** 本机 hostname（识别「不是本机的锁」） */
  host: string;
}

/** 读锁文件（异常都折叠成 LockInfo，诊断函数不该自己抛错） */
export function readLock(lockPath: string): LockInfo {
  const base: LockInfo = {
    path: lockPath,
    unreadable: false,
    holderPid: null,
    raw: null,
    host: hostname(),
  };
  try {
    // 必须 lstat（不跟随 symlink）：statSync 会跟到目标，把 symlink 判成「普通文件」→ 误报 unreadable
    const st = lstatSync(lockPath);
    if (!st.isSymbolicLink()) return { ...base, unreadable: true };
  } catch {
    return base; // 不存在 → 无锁
  }
  let raw: string;
  try {
    raw = readlinkSync(lockPath);
  } catch {
    return { ...base, unreadable: true };
  }
  const m = /-(\d+)$/.exec(raw);
  return { ...base, raw, holderPid: m ? Number(m[1]) : null };
}

/** 探活：`ps -p <n> -o pid=`（存在则回显一行）；ps 本身缺失/出错 → false */
export function holderAlive(holderPid: number): boolean {
  if (!Number.isInteger(holderPid) || holderPid <= 0) return false;
  try {
    const out = execFileSync("ps", ["-p", String(holderPid), "-o", "pid="], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"], // stderr 丢弃：进程不在时 ps 会刷一条
    }).trim();
    return out !== "";
  } catch {
    return false; // ps 非零退出 = 该 pid 不在
  }
}

/** 持有者是否在本机（link 目标按 `-数字` 结尾切，hostname 可含 `-`） */
export function lockIsLocal(info: LockInfo): boolean {
  if (info.raw === null) return false;
  const i = info.raw.lastIndexOf("-");
  return i > 0 ? info.raw.slice(0, i) === info.host : false;
}

/** 锁的几种处境（dev/CLI 文案的分支依据） */
export type LockSituation =
  | { kind: "free" }
  | { kind: "held"; holderPid: number } // 活实例占锁 → 可能窗口已关、仅常驻
  | { kind: "stale"; holderPid: number | null } // 陈旧锁：指向的进程不在了
  | { kind: "alien"; raw: string } // 指向别的 hostname（跨机共享文件系统）
  | { kind: "unreadable" }; // 不是 symlink（异常形态）

export function classifyLock(info: LockInfo, isLocal = lockIsLocal(info)): LockSituation {
  if (info.unreadable) return { kind: "unreadable" };
  if (info.raw === null) return { kind: "free" };
  if (!isLocal) return { kind: "alien", raw: info.raw };
  if (info.holderPid === null) return { kind: "unreadable" };
  return holderAlive(info.holderPid)
    ? { kind: "held", holderPid: info.holderPid }
    : { kind: "stale", holderPid: info.holderPid };
}

/**
 * 撞锁/启动失败时的建议文案：按处境给**下一步**，不是「失败了」。
 * @param lockPath 锁文件路径（诊断输出要给出，便于定位）
 */
export function lockAdvice(situation: LockSituation, lockPath: string): string {
  switch (situation.kind) {
    case "held":
      return (
        `单实例锁被运行中的实例占着 —— 关窗后它仍常驻（只占锁不显示窗口）。下一步二选一：\\n` +
        `  · 直接用它：./diy.sh <命令>（CLI 会连上这个实例）\\n` +
        `  · 要新开一个：先退出它，锁文件 ${lockPath}`
      );
    case "stale":
      return (
        `单实例锁是陈旧的（指向的进程已不在）：${lockPath}\\n` +
        `  · 通常重试一次即可（新实例会自建锁）；仍失败再 rm ${lockPath}`
      );
    case "alien":
      return `单实例锁指向别的机器（${situation.raw}）：${lockPath}（跨机共享文件系统？）`;
    case "unreadable":
      return `单实例锁形态异常（不是 symlink）：${lockPath} —— 可删后重试`;
    case "free":
      return `无单实例锁（${lockPath} 不存在）—— 不是锁的问题，查 $DIY_HOME/log/main.log`;
  }
}
