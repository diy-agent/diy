// src/main/services/process-sampler.ts
// 🎯 后台进程采样器（##401 L1 的采集端）—— 把「这个 pid 现在啥样」变成一份 `ProcessSample`。
//
// 分工：本文件**只采集 + 解析**，判据在 `shared/process-health.ts`（纯函数）。
// 这样解析可以拿固定文本夹具单测，判据可以拿构造样本单测，两头都不需要真进程。
//
// ⚠️ 两条来自 `~/AGENTS.md::tool.hang-detect` 的硬经验：
//   ① macOS 的 `top -l 1` 第一行 CPU 是**进程生命周期累计值**，只有 `-l 2` 的**第二块**才是瞬时值 ——
//      只看一块会把「历史上有过 99%」当成「此刻在跑」。
//   ② `lsof` 的 `-a` 不能省（否则条件变 or，串到别的进程的连接）。

import { execFileSync } from "node:child_process";
import type { ConnectionInfo, ProcessSample } from "../../shared/process-health";

/** 采集依赖（注入以便单测：真跑 `top` 一秒钟起步，测试不能等）。 */
export interface SamplerDeps {
    /** 跑一条命令拿 stdout；失败/超时一律返回 `""`（采集失败退化成「未知」，不许炸）。 */
    run(cmd: string, args: readonly string[], timeoutMs?: number): string;
    now(): number;
    platform: NodeJS.Platform;
}

export const DEFAULT_SAMPLER_DEPS: SamplerDeps = {
    run(cmd, args, timeoutMs = 3000) {
        try {
            return execFileSync(cmd, args as string[], {
                encoding: "utf8",
                timeout: timeoutMs,
                stdio: ["ignore", "pipe", "ignore"],
                maxBuffer: 4 * 1024 * 1024,
            });
        } catch {
            return "";
        }
    },
    now: () => Date.now(),
    platform: process.platform,
};

export interface SampleInput {
    readonly pid: number;
    readonly command: string;
    /** 调用方持续累计的输出字节（工具层有 stdout 流，知道这个数）。 */
    readonly outputBytes: number;
    /** 最后一次产出的时刻（ms epoch）；从未产出 = null。 */
    readonly lastOutputAt: number | null;
    /** 该命令历史耗时中位（ms），由 `medianDuration()` 算好后传入。 */
    readonly historicalP50Ms: number | null;
}

/** `ps -o etime=` 的 `[[dd-]hh:]mm:ss` → ms。认不出 = null。 */
export function parseEtime(text: string): number | null {
    const raw = text.trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw);
    if (!m) return null;
    const [, d, h, mi, s] = m;
    const days = d ? Number(d) : 0;
    const hours = h ? Number(h) : 0;
    return ((days * 24 + hours) * 60 + Number(mi)) * 60_000 + Number(s) * 1000;
}

/**
 * `top -l 2 ...` 的输出 → 该 pid 的**瞬时** CPU 百分比。
 * 取**最后一块**表头之后的行（`-l 2` 至少两块；最后一块才是瞬时值）。
 */
export function parseTopCpu(stdout: string, pid: number): number | null {
    const lines = stdout.split("\n");
    let headerAt = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*PID\s+CPU\s/.test(lines[i])) headerAt = i;
    }
    if (headerAt < 0) return null;
    for (let i = headerAt + 1; i < lines.length; i++) {
        const cols = lines[i].trim().split(/\s+/);
        if (cols.length < 2) break;
        if (Number(cols[0]) === pid) {
            const cpu = Number(cols[1]);
            return Number.isFinite(cpu) ? cpu : null;
        }
    }
    return null;
}

/** `ps -axo pid=,ppid=,comm=` → 以 `rootPid` 为根的**直接**子进程。 */
export function parseChildren(stdout: string, rootPid: number): { pid: number; command: string }[] {
    const out: { pid: number; command: string }[] = [];
    for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        if (Number(m[2]) === rootPid) out.push({ pid: Number(m[1]), command: m[3].trim() });
    }
    return out;
}

/** `lsof -nP -a -p <pid> -iTCP` → 连接（含状态；没有 REMOTE 的 LISTEN 行也保留）。 */
export function parseLsofTcp(stdout: string): ConnectionInfo[] {
    const out: ConnectionInfo[] = [];
    for (const line of stdout.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 8) continue;
        const state = cols[cols.length - 1];
        const remote = cols[cols.length - 2];
        if (!/^\(/.test(state)) continue;
        out.push({ remote, state: state.replace(/[()]/g, "") });
    }
    return out;
}

/** 采集一份现场。任何一步失败都退化成对应的 null / 0，**不抛**。 */
export function sampleProcess(input: SampleInput, deps: SamplerDeps = DEFAULT_SAMPLER_DEPS): ProcessSample {
    const pid = String(input.pid);
    const runMs = parseEtime(deps.run("ps", ["-o", "etime=", "-p", pid])) ?? 0;

    const cpu =
        deps.platform === "darwin"
            ? (parseTopCpu(deps.run("top", ["-l", "2", "-pid", pid, "-stats", "pid,cpu,time,command"], 5000), input.pid) ??
              0)
            : // 非 darwin 的 `ps %cpu` 本身就是衰减平均，够用
              (Number(deps.run("ps", ["-o", "%cpu=", "-p", pid]).trim()) || 0);

    const children = parseChildren(deps.run("ps", ["-axo", "pid=,ppid=,comm="]), input.pid);
    const connections = parseLsofTcp(deps.run("lsof", ["-nP", "-a", "-p", pid, "-iTCP"]));
    const silentMs = input.lastOutputAt === null ? runMs : Math.max(0, deps.now() - input.lastOutputAt);

    return {
        command: input.command,
        runMs,
        outputBytes: input.outputBytes,
        silentMs,
        cpuPercent: cpu,
        childCount: children.length,
        connections,
        historicalP50Ms: input.historicalP50Ms,
    };
}

/** 采样失败时的兜底样本（判据会走 R6:insufficient-evidence，不会误判成 stuck）。 */
export function emptySample(command: string, historicalP50Ms: number | null = null): ProcessSample {
    return {
        command,
        runMs: 0,
        outputBytes: 0,
        silentMs: 0,
        cpuPercent: 0,
        childCount: 0,
        connections: [],
        historicalP50Ms,
    };
}
