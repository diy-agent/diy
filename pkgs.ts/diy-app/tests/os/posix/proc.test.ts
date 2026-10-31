// tests/os/posix/proc.test.ts
// 🎯 POSIX 策略的**平台相关**解析与采集（独立测试集合：`./sha.sh test-os`）
//
// 这里可以出现 `ps` / `top` / `lsof` 的文本格式；OS 无关的判据在 tests/core/。
// 重点钉住 macOS 的两处坑：
//   ① `top -l 2` 的**第二块**才是瞬时 CPU（第一块是生命周期累计值，实测会把 0.3% 读成 99%）；
//   ② `lsof -nP -a -p <pid>` 必须带 `-a`（否则条件变 or，串到别的进程的连接）—— 解析侧只认带状态的行。

import { describe, it, expect } from "vitest";
import {
    createPosixOs,
    parseBasicRows,
    parseEnvironments,
    parseEtime,
    parseGpuInfo,
    parseHop,
    parseLsofTcp,
    parseProcRows,
    parseProcessTree,
    parseTopCpu,
    type PosixDeps,
} from "../../../src/main/os/posix";

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

/** 带 `%cpu` 列的进程表（树聚合用）：父 0.3%、子 97%、孙 45% —— 典型「父在等子」。 */
const PS_TREE_CPU = `  4200     1   0.3 node
  4210  4200  97.0 node
  4211  4200   0.1 ps
  4212  4211  45.0 sh
  4300     1  12.0 unrelated
`;

const LSOF = `COMMAND  PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    4200  ccc    5u  IPv4 0x2e930ed97b8e319d      0t0  TCP 127.0.0.1:8787 (LISTEN)
node    4200  ccc    6u  IPv4 0x2e930ed97c1eec45      0t0  TCP 100.81.37.7:64874->172.65.90.22:443 (ESTABLISHED)
`;

function deps(map: Record<string, string>, platform: NodeJS.Platform = "darwin"): PosixDeps {
    const runSync = (cmd: string, args: readonly string[]): string => map[[cmd, ...args].join(" ")] ?? "";
    return {
        runSync,
        run: async (cmd, args) => runSync(cmd, args),
        tryRunSync: (cmd, args) => (map[[cmd, ...args].join(" ")] ?? null) !== null,
        platform,
        now: () => 1_000_000,
    };
}

describe("parseProcRows —— ps -axo 六列 + 命令行全文", () => {
    it("command 含空格也必须完整", () => {
        const [r] = parseProcRows("   120      1    120     01:02  3.5    2048 /bin/bash -c sleep 300");
        expect(r).toEqual({
            pid: 120,
            ppid: 1,
            pgid: 120,
            etimeText: "01:02",
            pcpu: 3.5,
            rssKb: 2048,
            command: "/bin/bash -c sleep 300",
        });
    });

    it("空行 / 畸形行跳过，不抛", () => {
        expect(parseProcRows("")).toEqual([]);
        expect(parseProcRows("garbage\n  1 2 3")).toEqual([]);
    });
});

describe("parseBasicRows / parseHop / parseEnvironments", () => {
    it("基础三列：跳过表头与畸形行", () => {
        expect(parseBasicRows("  PID  PPID COMMAND\n 2339 1 node main.js\n")).toEqual([
            { pid: 2339, ppid: 1, command: "node main.js" },
        ]);
    });

    it("父进程一跳", () => {
        expect(parseHop(" 42 1 zsh -l")).toEqual({ pid: 42, ppid: 1, command: "zsh -l" });
        expect(parseHop("")).toBeNull();
    });

    it("ps eww：环境变量按 pid 归组（表头/杂行跳过）", () => {
        const text = `  PID  TT  STAT   TIME COMMAND
   10  s000  S+    0:00.01 /bin/bash DIY_HOME=/tmp/a PATH=/bin
   11  s000  S+    0:00.01 node x.js DIY_HOME=/tmp/b`;
        const envs = parseEnvironments(text);
        expect(envs.get(10)).toEqual({ DIY_HOME: "/tmp/a", PATH: "/bin" });
        expect(envs.get(11)).toEqual({ DIY_HOME: "/tmp/b" });
    });
});

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

describe("parseLsofTcp", () => {
    it("取 remote + state（LISTEN 也保留）", () => {
        const conns = parseLsofTcp(LSOF);
        expect(conns).toHaveLength(2);
        expect(conns[1]).toEqual({ remote: "100.81.37.7:64874->172.65.90.22:443", state: "ESTABLISHED" });
        expect(conns[0]!.state).toBe("LISTEN");
    });

    it("没有状态列的行（表头 / 杂行）被丢弃", () => {
        expect(parseLsofTcp("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n")).toHaveLength(0);
    });
});

describe("parseProcessTree —— 进程树 CPU 聚合", () => {
    it("root + 全部后代求和；兄弟树不算进来（同一父的孙进程要算）", () => {
        const t = parseProcessTree(PS_TREE_CPU, 4200);
        expect(t.treeCpuPercent).toBe(142.4);
        expect(t.descendants.map((d) => d.pid)).toEqual([4210, 4211, 4212]);
        expect(t.directChildCount).toBe(2);
    });

    it("root 为 0%、子进程在算 ⇒ 树聚合不为 0（这就是修 R1 的那一刀）", () => {
        expect(parseProcessTree(PS_TREE_CPU, 4200).treeCpuPercent).toBeGreaterThan(50);
    });

    it("root 不在表里（进程已退 / ps 失败）⇒ 全 0，不抛、不编数字", () => {
        expect(parseProcessTree(PS_TREE_CPU, 9999)).toEqual({ directChildCount: 0, descendants: [], treeCpuPercent: 0 });
        expect(parseProcessTree("", 4200).treeCpuPercent).toBe(0);
    });

    it("pid 复用成环也不会死循环（seen 防御）", () => {
        const cyclic = `  1     2  50.0 a\n  2     1  50.0 b\n`;
        const t = parseProcessTree(cyclic, 1);
        expect(t.descendants.map((d) => d.pid)).toEqual([2]);
        expect(t.treeCpuPercent).toBe(100);
    });
});

describe("parseGpuInfo", () => {
    it("Metal GPUFamily / Chipset Model 解析", () => {
        const text = "Chipset Model: Apple M2\nMetal Family: Supported, Metal GPUFamily macOS 3";
        expect(parseGpuInfo(text)).toEqual({ metalFamily: 3, gpuName: "Apple M2", shouldUseAngle: false });
    });
});

describe("createPosixOs —— 采集编排（注入命令输出）", () => {
    it("snapshotSync 走 ps 并归一化", () => {
        const os = createPosixOs(deps({ "ps -axo pid=,ppid=,pgid=,etime=,pcpu=,rss=,command=": " 1 0 1 00:01 0.0 100 init" }));
        expect(os.snapshotSync()?.map((r) => r.pid)).toEqual([1]);
        // etime（秒级）反推创建时刻：POSIX 侧只是兜底精度（Windows 有 100ns 的 CreationDate）
        expect(os.snapshotSync()?.[0]?.createdAt).toBe(1_000_000 - 1_000);
    });

    it("ps 失败 ⇒ null（调用方据此说「没扫到」而不是「没有进程」）", () => {
        expect(createPosixOs(deps({})).snapshotSync()).toBeNull();
    });

    it("ownProcesses 用真 pgid 认领；jobAlive 看组", async () => {
        const os = createPosixOs(
            deps({ "ps -axo pid=,ppid=,pgid=,etime=,pcpu=,rss=,command=": " 501 1 500 00:10 0.0 100 sleep 600" }),
        );
        const got = await os.ownProcesses({
            selfPid: 100,
            groups: new Map([[500, { at: 1, command: "nohup sleep 600 &", cwd: "/tmp", runId: "r-1" }]]),
            runPids: new Map(),
        });
        expect(got.ok).toBe(true);
        expect(got.procs[0]).toMatchObject({ pid: 501, pgid: 500, claim: "pgid", runId: "r-1" });
        // live = 登记过的号 ∩ 快照 + 仍有后代的锚点：根 500 不在快照，但 501 还在组里 ⇒ 保留
        expect(got.live.has(500)).toBe(true);
        expect(got.live.has(999)).toBe(false);
        expect(os.jobAlive(0)).toBe(false);
        expect(os.facts().join("\n")).toContain("进程组");
    });

    it("probe：时长 / CPU / 树 / 连接 / 内存一次取齐（P0：connections 不许恒空）", () => {
        const os = createPosixOs(
            deps({
                "ps -o etime= -p 4200": "  10:00",
                "top -l 2 -pid 4200 -stats pid,cpu,time,command": TOP_L2,
                "ps -axo pid=,ppid=,pcpu=,comm=": PS_TREE_CPU,
                "lsof -nP -a -p 4200 -iTCP": LSOF,
                "ps -o rss= -p 4200": "2048",
            }),
        );
        const p = os.probe(4200);
        expect(p.runMs).toBe(600_000);
        expect(p.cpuPercent).toBe(0.3);
        expect(p.tree?.treeCpuPercent).toBe(142.4);
        expect(p.connections).toHaveLength(2);
        expect(p.rssKb).toBe(2048);
    });

    it("非 macOS：GPU / 系统级前置声明不支持", () => {
        const os = createPosixOs(deps({}, "linux"));
        expect(os.caps.gpu).toBe(false);
        expect(os.caps.runLifetime).toBe("groups");
        expect(os.caps.gracefulSignals).toBe(true);
        expect(os.caps.orphanRecovery).toBe("groups");
        expect(os.focusProcess(42)).toBe(false);
    });
});
