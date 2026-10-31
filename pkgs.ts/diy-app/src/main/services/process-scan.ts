// 🎯 拿「我们起的那些进程」—— ##408 刀 10
//
// 分工：**取数 + 认领**在 `os.ownProcesses()`（意图级，见 os/types.ts R2）；本文件只做编排：
// 准备两组登记表、给名册做回收、把结果包装成面板要的形状。
//
// 拉式：**只在有人问的时候扫**（面板刷新 / `<tool>job ps</tool>`）。没有定时器、没有后台轮询 ——
// 「观测」不该自己变成负担。
//
// **异步**：用户 2026-10-24 定下硬规范「app 里不许有同步 IO」。

import { os, type OwnedSnapshot } from "../os";
import { ownedGroups, type OwnedGroups } from "./owned-groups";
import { KILL_GRACE_MS } from "./run-registry";
import type { GroupOwner, OwnedProc } from "../../shared/proc-scan";

export interface ScanDeps {
    /** 取「归我们管的进程」（缺省 `os.ownProcesses`；注入只为单测） */
    own(query: {
        selfPid: number;
        groups: ReadonlyMap<number, GroupOwner>;
        runPids: ReadonlyMap<number, string>;
    }): Promise<OwnedSnapshot>;
    now(): number;
    /** app 主进程 pid（子孙也算我们起的） */
    selfPid: number;
}

export const DEFAULT_SCAN_DEPS: ScanDeps = {
    own: (query) => os.ownProcesses(query),
    now: () => Date.now(),
    selfPid: process.pid,
};

export interface ScanResult {
    at: number;
    /** 归我们管的进程（含未登记的野进程），pid 升序 */
    procs: OwnedProc[];
    /** 本轮快照是否成功（失败时 procs 为空，调用方要如实说"没扫到"而不是"没有进程"） */
    ok: boolean;
    /** 平台能力/寿命差异的事实句（R10；UI / `job ps` 直接展示） */
    facts: string[];
}

/**
 * 扫一次。
 *
 * `groups` / `runPids` 由调用方给（默认取全局名册 + 传进来的 run 根 pid 表），
 * 这样单测可以完全注入而不碰全局单例。
 */
export async function scanOwnedProcs(opts: {
    deps?: ScanDeps;
    groups?: OwnedGroups;
    /** run 根 pid → runId */
    runPids: ReadonlyMap<number, string>;
}): Promise<ScanResult> {
    const deps = opts.deps ?? DEFAULT_SCAN_DEPS;
    const groups = opts.groups ?? ownedGroups;
    // 首读（跨重启认领）可能还没完成：等它，否则会把老孤儿当"别人的进程"
    await groups.ready;
    const res = await deps.own({ selfPid: deps.selfPid, groups: groups.snapshot(), runPids: opts.runPids });
    const at = deps.now();
    if (!res.ok) {
        onScanFailed();
        return { at, procs: [], ok: false, facts: os.facts() };
    }
    // 清理名册：本轮扫不到进程的组（过宽限期）丢掉，名册不会无限长
    groups.retain(res.live, at);
    return { at, procs: res.procs, ok: true, facts: os.facts() };
}

/** 扫描失败：退化成"看不见"，但**不许静默**（限流打日志）。 */
let lastScanWarnAt = 0;
function onScanFailed(): void {
    const now = Date.now();
    if (now - lastScanWarnAt > 60_000) {
        lastScanWarnAt = now;
        console.warn("[scan] 进程快照失败（见 os 策略 / 控制台）");
    }
}

/**
 * 结束一条"归我们管"的进程（**意图**，R3：只代表「结束请求已发出」）。
 *
 * ⚠️ lineage-only 认领不能直接杀：父链指向我们记录过的根，不等于不是 pid 复用出来的新进程；
 * 必须带创建时刻（选择阶段的时间窗已经过滤过一次）。
 */
export function killOwnedProc(proc: {
    pid: number;
    pgid: number | null;
    claim?: "pgid" | "run-root" | "descendant" | "lineage";
    createdAt?: number | null;
}): boolean {
    if (proc.claim === "lineage" && proc.createdAt == null) return false;
    const target = [{ pid: proc.pid, pgid: proc.pgid }];
    if (!os.caps.gracefulSignals) {
        os.killOwned(target, "SIGKILL");
        return true;
    }
    os.killOwned(target, "SIGTERM");
    const timer = setTimeout(() => {
        // 单 pid 判活用 Node 的 0 信号（跨平台，不是系统假设）
        try {
            process.kill(proc.pid, 0);
        } catch {
            return;
        }
        os.killOwned(target, "SIGKILL");
    }, KILL_GRACE_MS);
    timer.unref?.();
    return true;
}

/** 组名册里某组的自述（面板"这条命令是谁留下的"）；扫不到给 `undefined`。 */
export function groupOwnerOf(pgid: number | null): GroupOwner | undefined {
    return pgid === null ? undefined : ownedGroups.get(pgid);
}
