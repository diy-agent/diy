// tests/core/process-sampler.test.ts
// 🎯 ##401 L1 采集端的解析（`main/services/process-sampler.ts`）—— 拿固定文本夹具，不起真进程
//
// 重点钉住 macOS 的两处坑：
//   ① `top -l 2` 的**第二块**才是瞬时 CPU（第一块是生命周期累计值，实测会把 0.3% 读成 99%）；
//   ② `lsof -nP -a -p <pid>` 必须带 `-a`（否则条件变 or，串到别的进程的连接）—— 解析侧只认带状态的行。

import { describe, it, expect } from "vitest";
import {
    emptySample,
    parseChildren,
    parseEtime,
    parseLsofTcp,
    parseTopCpu,
    sampleProcess,
    type SamplerDeps,
} from "../../src/main/services/process-sampler";

const TOP_L2 = `Processes: 900 total, 3 running, 897 sleeping, 4500 threads
2026/10/22 09:12:01
Load Avg: 2.10, 2.05, 1.98  CPU usage: 5.2% user, 3.1% sys, 91.6% idle
SharedLibs: 400M resident, 60M data, 30M linkedit.
MemRegions: 100000 total, 3000M resident, 200M private, 500M shared.
PhysMem: 16G used, 16G wired, 2000M compressed.
VM: 500G vsize, 4000M framework vsize, 0(0) pageins, 0(0) pageouts.
Networks: packets: 1000/2000 in, 2000/1000 out.
Disks: 50000/1000 read, 5000/500 write.
PID    CPU    TIME      COMMAND
4200   98.7   12:03.44  node     <- 第一块：进程生命周期累计/平滑值
4201   0.0    00:00.01  ps

PID    CPU    TIME      COMMAND
4200   0.3    12:03.51  node     <- 第二块：这才是瞬时值
4201   0.0    00:00.02  ps
`;

const PS_TREE = `  4200     1 node
  4210  4200 node
  4211  4200 ps
  4212  4211 sh
`;

const LSOF = `COMMAND  PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    4200  ccc    5u  IPv4 0x2e930ed97b8e319d      0t0  TCP 127.0.0.1:8787 (LISTEN)
node    4200  ccc    6u  IPv4 0x2e930ed97c1eec45      0t0  TCP 100.81.37.7:64874->172.65.90.22:443 (ESTABLISHED)
`;

function deps(map: Record<string, string>, now = 1_000_000): SamplerDeps {
    return {
        run: (cmd, args) => map[[cmd, ...args].join(" ")] ?? "",
        now: () => now,
        platform: "darwin",
    };
}

describe("parseEtime", () => {
    it("`mm:ss` / `hh:mm:ss` / `dd-hh:mm:ss` 都能认", () => {
        expect(parseEtime("  03:04")).toBe(184_000);
        expect(parseEtime("1:02:03")).toBe(3_723_000);
        expect(parseEtime("2-01:00:05")).toBe((2 * 24 * 3600 + 3605) * 1000);
    });

    it("认不出 ⇒ null（不编数字）", () => {
        expect(parseEtime("")).toBeNull();
        expect(parseEtime("--")).toBeNull();
    });
});

describe("parseTopCpu —— 只认第二块", () => {
    it("`top -l 2` 取最后一块的瞬时值，不是第一块的累计值", () => {
        expect(parseTopCpu(TOP_L2, 4200)).toBe(0.3);
        expect(parseTopCpu(TOP_L2, 4200)).not.toBe(98.7); // 反证：取错块就会拿到这个
    });

    it("pid 不在输出里 / 输出为空 ⇒ null", () => {
        expect(parseTopCpu(TOP_L2, 9999)).toBeNull();
        expect(parseTopCpu("", 4200)).toBeNull();
    });
});

describe("parseChildren / parseLsofTcp", () => {
    it("子进程只取**直接**子节点（孙进程不算）", () => {
        expect(parseChildren(PS_TREE, 4200).map((c) => c.pid)).toEqual([4210, 4211]);
        expect(parseChildren(PS_TREE, 4211).map((c) => c.pid)).toEqual([4212]);
    });

    it("lsof 取 remote + state（LISTEN 也保留）", () => {
        const conns = parseLsofTcp(LSOF);
        expect(conns).toHaveLength(2);
        expect(conns[1]).toEqual({ remote: "100.81.37.7:64874->172.65.90.22:443", state: "ESTABLISHED" });
        expect(conns[0].state).toBe("LISTEN");
    });

    it("没有状态列的行（表头 / 杂行）被丢弃", () => {
        expect(parseLsofTcp("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n")).toHaveLength(0);
    });
});

describe("sampleProcess —— 组装", () => {
    it("runMs / cpu / 子进程 / 连接 / silentMs 全部就位", () => {
        const d = deps(
            {
                "ps -o etime= -p 4200": "  10:00",
                "top -l 2 -pid 4200 -stats pid,cpu,time,command": TOP_L2,
                "ps -axo pid=,ppid=,comm=": PS_TREE,
                "lsof -nP -a -p 4200 -iTCP": LSOF,
            },
            1_000_000,
        );
        const s = sampleProcess(
            {
                pid: 4200,
                command: "node build.js",
                outputBytes: 1234,
                lastOutputAt: 700_000, // 300s 前
                historicalP50Ms: 30_000,
            },
            d,
        );
        expect(s.runMs).toBe(600_000);
        expect(s.cpuPercent).toBe(0.3);
        expect(s.childCount).toBe(2);
        expect(s.connections).toHaveLength(2);
        expect(s.silentMs).toBe(300_000);
        expect(s.outputBytes).toBe(1234);
    });

    it("从未输出过 ⇒ silentMs = runMs（不是 0，别让判据以为「刚有输出」）", () => {
        const d = deps({ "ps -o etime= -p 4200": "  02:00", "top -l 2 -pid 4200 -stats pid,cpu,time,command": TOP_L2 }, 1_000_000);
        const s = sampleProcess(
            { pid: 4200, command: "x", outputBytes: 0, lastOutputAt: null, historicalP50Ms: null },
            d,
        );
        expect(s.silentMs).toBe(120_000);
    });

    it("命令全失败（run 返回空）⇒ 退化成 0 / 空，不抛", () => {
        const s = sampleProcess(
            { pid: 1, command: "x", outputBytes: 0, lastOutputAt: null, historicalP50Ms: null },
            deps({}),
        );
        expect(s.runMs).toBe(0);
        expect(s.cpuPercent).toBe(0);
        expect(s.connections).toEqual([]);
    });

    it("emptySample ⇒ 判据走「证据不足」，不会误判成 stuck", () => {
        expect(emptySample("x").silentMs).toBe(0);
        expect(emptySample("x").connections).toEqual([]);
    });
});
