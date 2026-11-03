// src/main/services/process-sampler.ts
// 🎯 后台进程采样器（##401 L1 的采集端）—— 把「这个 pid 现在啥样」变成一份 `ProcessSample`。
//
// 分工：**取数**在 `os.probe(pid)`（观测类，R2 修订后允许在 L2）；本文件只做组装，
// 判据在 `shared/process-health.ts`（纯函数）。
// POSIX 的 probe 复用 ps/top/lsof；Windows 的 connections 由 `caps.tcpConnections=false` 明说未采集。

import { os as defaultOs, type OsStrategy } from "../os";
import type { ProcessSample } from "../../shared/process-health";

/** 采集依赖（注入以便单测：真跑系统命令太慢，测试不能等）。 */
export interface SamplerDeps {
    /** 观测快照（缺省单例；注入假对象即可在任意平台单测组装逻辑） */
    os: Pick<OsStrategy, "probe">;
    now(): number;
}

export const DEFAULT_SAMPLER_DEPS: SamplerDeps = {
    os: defaultOs,
    now: () => Date.now(),
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

/** 采集一份现场。任何一步失败都退化成对应的 null / 0，**不抛**。 */
export function sampleProcess(input: SampleInput, deps: SamplerDeps = DEFAULT_SAMPLER_DEPS): ProcessSample {
    const probe = deps.os.probe(input.pid);
    const runMs = probe.runMs ?? 0;
    const silentMs = input.lastOutputAt === null ? runMs : Math.max(0, deps.now() - input.lastOutputAt);

    return {
        command: input.command,
        runMs,
        outputBytes: input.outputBytes,
        silentMs,
        cpuPercent: probe.cpuPercent ?? 0,
        treeCpuPercent: probe.tree?.treeCpuPercent ?? 0,
        childCount: probe.tree?.directChildCount ?? 0,
        connections: probe.connections,
        ...(probe.rssKb !== null ? { memoryRssKb: probe.rssKb } : {}),
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
