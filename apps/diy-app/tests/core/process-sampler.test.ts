// tests/core/process-sampler.test.ts
// 🎯 采集端**组装层**（OS 无关）：把 OS 观测 `probe(pid)` 装成 `ProcessSample`。

import { describe, it, expect } from "vitest";
import { emptySample, sampleProcess, type SamplerDeps } from "../../src/main/services/process-sampler";
import type { ProcessProbe } from "../../src/main/os";

function deps(probe: Partial<ProcessProbe>, now = 1_000_000): SamplerDeps {
    return {
        os: {
            probe: () => ({
                runMs: null,
                cpuPercent: null,
                tree: null,
                connections: [],
                rssKb: null,
                ...probe,
            }),
        },
        now: () => now,
    };
}

describe("sampleProcess —— 组装", () => {
    it("runMs / cpu / 子树 / 连接 / silentMs 全部就位", () => {
        const s = sampleProcess(
            {
                pid: 4200,
                command: "node build.js",
                outputBytes: 1234,
                lastOutputAt: 700_000, // 300s 前
                historicalP50Ms: 30_000,
            },
            deps({
                runMs: 600_000,
                cpuPercent: 0.3,
                tree: {
                    directChildCount: 2,
                    descendants: [
                        { pid: 4210, command: "node" },
                        { pid: 4212, command: "sh" },
                    ],
                    treeCpuPercent: 142.4,
                },
                connections: [
                    { remote: "127.0.0.1:8787", state: "LISTEN" },
                    { remote: "100.81.37.7:64874->172.65.90.22:443", state: "ESTABLISHED" },
                ],
                rssKb: 2048,
            }),
        );
        expect(s.runMs).toBe(600_000);
        expect(s.cpuPercent).toBe(0.3);
        expect(s.childCount).toBe(2);
        expect(s.treeCpuPercent).toBe(142.4);
        expect(s.connections).toHaveLength(2); // P0：连接不再恒空
        expect(s.silentMs).toBe(300_000);
        expect(s.outputBytes).toBe(1234);
        expect(s.memoryRssKb).toBe(2048);
    });

    it("从未输出过 ⇒ silentMs = runMs（不是 0，别让判据以为「刚有输出」）", () => {
        const s = sampleProcess(
            { pid: 4200, command: "x", outputBytes: 0, lastOutputAt: null, historicalP50Ms: null },
            deps({ runMs: 120_000 }),
        );
        expect(s.silentMs).toBe(120_000);
    });

    it("策略没采到 ⇒ 退化成 0 / 空，不抛", () => {
        const s = sampleProcess(
            { pid: 1, command: "x", outputBytes: 0, lastOutputAt: null, historicalP50Ms: null },
            deps({}),
        );
        expect(s.runMs).toBe(0);
        expect(s.cpuPercent).toBe(0);
        expect(s.treeCpuPercent).toBe(0);
        expect(s.childCount).toBe(0);
        expect(s.connections).toEqual([]);
        expect(s.memoryRssKb).toBeUndefined(); // 采不到就不写字段（不把 0 当事实）
    });

    it("emptySample ⇒ 判据走「证据不足」，不会误判成 stuck", () => {
        expect(emptySample("x").silentMs).toBe(0);
        expect(emptySample("x").connections).toEqual([]);
    });
});
