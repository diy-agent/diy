// 🎯 真跑 `ps` 拿全机快照，再按判据挑出「归我们管」的进程 —— ##408 刀 10
//
// 分工：解析/认领判据在 `shared/proc-scan.ts`（纯函数，单测用文本夹具），本文件只做两件事
// —— 跑 `ps`、把两份表（组名册 + run 根 pid）喂给判据。
//
// 拉式：**只在有人问的时候扫**（面板刷新 / `<tool>job ps</tool>`）。没有定时器、没有后台轮询 ——
// 「观测」不该自己变成负担。

import { execFileSync } from "node:child_process";
import { ownedGroups, type OwnedGroups } from "./owned-groups";
import { KILL_GRACE_MS } from "./run-registry";
import {
    parsePsRows,
    selectOwnedProcs,
    type GroupOwner,
    type OwnedProc,
} from "../../shared/proc-scan";

let lastScanWarnAt = 0;

export interface ScanDeps {
    /** 跑命令拿 stdout；失败返回 `""`（采集失败退化成"看不见"，不许炸业务）。 */
    run(cmd: string, args: readonly string[], timeoutMs?: number): string;
    now(): number;
    /** app 主进程 pid（子孙也算我们起的） */
    selfPid: number;
}

export const DEFAULT_SCAN_DEPS: ScanDeps = {
    run(cmd, args, timeoutMs = 1500) {
        try {
            return execFileSync(cmd, args as string[], {
                encoding: "utf8",
                timeout: timeoutMs,
                stdio: ["ignore", "pipe", "ignore"],
                maxBuffer: 8 * 1024 * 1024,
            });
        } catch (e) {
            // 扫描失败退化成"看不见"，但**不许静默**：面板会显示「没扫到」，而人要能查出为什么
            // （实测的第一次：机器内存只剩 0.2GB，fork 出 ps 失败 ⇒ EAGAIN，界面像"没有进程"）。
            // 限流打印，避免每 3 秒刷一次。
            const now = Date.now();
            if (now - lastScanWarnAt > 60_000) {
                lastScanWarnAt = now;
                const code = (e as NodeJS.ErrnoException | undefined)?.code;
                console.warn("[scan] ps 失败:", code ?? (e instanceof Error ? e.message : String(e)));
            }
            return "";
        }
    },
    now: () => Date.now(),
    selfPid: process.pid,
};

export interface ScanResult {
    at: number;
    /** app 主进程自己的进程组（判"按组杀会不会连累 app"，见 `killOwnedProc`）；扫不到给 null */
    selfPgid: number | null;
    /** 归我们管的进程（含未登记的野进程），pid 升序 */
    procs: OwnedProc[];
    /** 本轮 `ps` 是否成功（失败时 procs 为空，调用方要如实说"没扫到"而不是"没有进程"） */
    ok: boolean;
}

/** ps 的列：pid ppid pgid etime pcpu rss command（command 必须最后，它含空格）。 */
const PS_ARGS = ["-axo", "pid=,ppid=,pgid=,etime=,pcpu=,rss=,command="] as const;

/**
 * 扫一次。
 *
 * `groups` / `runPids` 由调用方给（默认取全局名册 + 传进来的 run 根 pid 表），
 * 这样单测可以完全注入而不碰全局单例。
 */
export function scanOwnedProcs(opts: {
    deps?: ScanDeps;
    groups?: OwnedGroups;
    /** run 根 pid → runId */
    runPids: ReadonlyMap<number, string>;
}): ScanResult {
    const deps = opts.deps ?? DEFAULT_SCAN_DEPS;
    const groups = opts.groups ?? ownedGroups;
    const stdout = deps.run("ps", PS_ARGS);
    const at = deps.now();
    if (!stdout.trim()) return { at, selfPgid: null, procs: [], ok: false };
    const rows = parsePsRows(stdout);
    const selfRow = rows.find((r) => r.pid === deps.selfPid);
    const procs = selectOwnedProcs(rows, {
        selfPid: deps.selfPid,
        groups: groups.snapshot(),
        runPids: opts.runPids,
    });
    // 清理名册：本轮扫不到进程的组（过宽限期）丢掉，名册不会无限长
    const live = new Set(rows.map((r) => r.pgid));
    groups.retain(live, at);
    return { at, selfPgid: selfRow?.pgid ?? null, procs, ok: true };
}

/**
 * 结束一条"归我们管"的进程。
 *
 * ⚠️ 两个安全判据（都不是洁癖）：
 *   ① 只在**同组**时才按组杀（`kill(-pgid)`）—— 若那条进程和 app 同组（没走 detached 的漏网），
 *      按组杀会把 app 自己一起带走；那种情况只杀它自己。
 *   ② 先 SIGTERM 后（`KILL_GRACE_MS` 后）SIGKILL：给进程自己收尾的机会（写盘 / 关连接）。
 * 返回是否真的发出了信号（pid 已被回收 ⇒ false，不抛）。
 */
export function killOwnedProc(proc: { pid: number; pgid: number }, selfPgid: number | null): boolean {
    // 判据 ①：和 app 同组 ⇒ 只能杀它自己（按组杀会把 app 一起带走）
    const sameGroupAsApp = selfPgid !== null && proc.pgid === selfPgid;
    const send = (sig: NodeJS.Signals): boolean => {
        try {
            if (!sameGroupAsApp && proc.pgid > 1) process.kill(-proc.pgid, sig);
            else process.kill(proc.pid, sig);
            return true;
        } catch {
            return false;
        }
    };
    const ok = send("SIGTERM");
    const timer = setTimeout(() => {
        if (!isAlive(proc.pid)) return;
        send("SIGKILL");
    }, KILL_GRACE_MS);
    timer.unref?.();
    return ok;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** 组名册里某组的自述（面板"这条命令是谁留下的"）；扫不到给 `undefined`。 */
export function groupOwnerOf(pgid: number): GroupOwner | undefined {
    return ownedGroups.get(pgid);
}
