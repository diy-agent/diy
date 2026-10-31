// tests/os/win32/win32.test.ts
// 🎯 Windows 策略的**平台相关**解析与采集（独立测试集合：`./sha.sh test-os`）
//
// 命令执行被注入，不真起 PowerShell / taskkill；任意平台都能跑。

import { describe, it, expect } from "vitest";
import {
    createWin32Os,
    discoverShellSpecs,
    parseCimRows,
    parseWmicRows,
    pwshCandidates,
    shellCandidates,
    type Win32Deps,
} from "../../../src/main/os/win32";
import { formatEtime } from "../../../src/main/os/duration";

const CIM_ONE = JSON.stringify({
    ProcessId: 4200,
    ParentProcessId: 1,
    CommandLine: "C:\\Program Files\\Electron\\electron.exe C:\\repo\\build\\prod\\main\\index.mjs",
    CreationDate: `/Date(${1_000_000 - 600_000})/`,
    WorkingSetSize: 2_097_152,
    KernelModeTime: 0,
    UserModeTime: 0,
});

const CIM_MANY = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0, CommandLine: null, CreationDate: null, WorkingSetSize: 0 },
    { ProcessId: 4200, ParentProcessId: 1, CommandLine: "node a.js", CreationDate: `/Date(999400)/`, WorkingSetSize: 2048 },
    { ProcessId: 4210, ParentProcessId: 4200, CommandLine: "node child.js", CreationDate: `/Date(999400)/`, WorkingSetSize: 1024 },
]);

function deps(map: Record<string, string>, existing: string[] = [], now = 1_000_000): Win32Deps {
    const runSync = (cmd: string, args: readonly string[]): string => map[[cmd, ...args].join(" ")] ?? "";
    return {
        runSync,
        run: async (cmd, args) => runSync(cmd, args),
        tryRunSync: (cmd, args) => Boolean(map[[cmd, ...args].join(" ")]),
        spawnDetached: () => true,
        exists: (p) => existing.includes(p),
        env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        now: () => now,
    };
}

describe("shell 能力探测 —— bash 缺席不是错误（R6/R7）", () => {
    it("DIY_SHELL 优先；Git Bash 常见位置与 PATH 都认；System32 的 WSL 桩跳过", () => {
        const cands = shellCandidates({
            DIY_SHELL: "D:\\tools\\bash.exe",
            ProgramFiles: "C:\\Program Files",
            LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
            PATH: "C:\\Windows\\System32;C:\\tools\\msys64\\usr\\bin",
        });
        expect(cands[0]).toBe("D:\\tools\\bash.exe");
        expect(cands).toContain("C:\\Program Files\\Git\\bin\\bash.exe");
        expect(cands).toContain("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
        expect(cands).toContain("C:\\tools\\msys64\\usr\\bin\\bash.exe");
        expect(cands.some((p) => /System32/i.test(p))).toBe(false);
    });

    it("pwsh 7 优先于 Windows PowerShell 5.1", () => {
        const cands = pwshCandidates({ ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", PATH: "" });
        expect(cands.indexOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBeLessThan(
            cands.indexOf("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
        );
    });

    it("没装 Git Bash ⇒ 只返回 pwsh 能力（不是错误）", () => {
        const specs = discoverShellSpecs(
            { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
            (p) => p === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
        expect(specs.map((s) => s.kind)).toEqual(["pwsh"]);
    });

    it("DIY_SHELL 指错 ⇒ 不再猜 Git Bash，只降级到 pwsh（可复现的「无 bash」）", () => {
        const specs = discoverShellSpecs(
            { DIY_SHELL: "C:\\nope\\bash.exe", ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
            (p) =>
                p === "C:\\Program Files\\Git\\bin\\bash.exe" ||
                p === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
        expect(specs.map((s) => s.kind)).toEqual(["pwsh"]);
    });

    it("两种能力都在 ⇒ 都返回（bash 在前，工具面并存）", () => {
        const specs = discoverShellSpecs(
            { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
            (p) =>
                p === "C:\\Program Files\\Git\\bin\\bash.exe" ||
                p === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
        expect(specs.map((s) => s.kind)).toEqual(["bash", "pwsh"]);
    });
});

describe("parseCimRows / parseWmicRows —— pgid 必须是 null（R4）", () => {
    it("CIM 单个对象 / 数组都认；etime / rss / createdAt 归一化", () => {
        const one = parseCimRows(CIM_ONE, 1_000_000);
        expect(one[0]).toMatchObject({
            pid: 4200,
            ppid: 1,
            pgid: null,
            etimeText: "10:00",
            rssKb: 2048,
            createdAt: 400_000,
        });
        expect(parseCimRows(CIM_MANY, 1_000_000).map((r) => r.pid)).toEqual([1, 4200, 4210]);
    });

    it("坏 JSON / 空输出 ⇒ 空表；ISO 时间也能认", () => {
        expect(parseCimRows("")).toEqual([]);
        expect(parseCimRows("{not json")).toEqual([]);
        const text = JSON.stringify({
            ProcessId: 9,
            ParentProcessId: 1,
            CommandLine: "x",
            CreationDate: new Date(1_000_000 - 3_600_000).toISOString(),
            WorkingSetSize: 0,
        });
        expect(parseCimRows(text, 1_000_000)[0]!.etimeText).toBe(formatEtime(3_600_000));
    });

    it("wmic /format:list：空行分块、CommandLine 含 = 完整、pgid=null", () => {
        const list = [
            "CommandLine=node a.js",
            "CreationDate=20261031060000.000000+000",
            "ParentProcessId=1",
            "ProcessId=4200",
            "WorkingSetSize=2048",
            "",
        ].join("\r\n");
        const now = Date.UTC(2026, 9, 31, 7, 0, 0);
        expect(parseWmicRows(list, now)[0]).toMatchObject({
            pid: 4200,
            ppid: 1,
            pgid: null,
            command: "node a.js",
            etimeText: "01:00:00",
        });
    });
});

describe("createWin32Os —— 意图级接口", () => {
    it("caps：无进程组 / 无环境变量 / 无 lsof / 寿命跟根进程 / 无信号语义", () => {
        const os = createWin32Os(deps({}));
        expect(os.caps).toMatchObject({
            processGroups: false,
            processEnvironments: false,
            tcpConnections: false,
            shellRedirectsLog: true,
            keepRunningOnWindowClose: false,
            runLifetime: "root",
            gracefulSignals: false,
            orphanRecovery: "lineage",
        });
    });

    it("killOwned：活着才发 taskkill，已回收的 pid 不发（R3/R5 契约）", () => {
        const calls: string[][] = [];
        const os = createWin32Os({
            ...deps({}),
            spawnDetached: (cmd, args) => {
                calls.push([cmd, ...args]);
                return true;
            },
        });
        os.killOwned([{ pid: process.pid, pgid: null }]);
        expect(calls[0]).toEqual(["taskkill", "/pid", String(process.pid), "/T", "/F"]);
        os.killOwned([{ pid: 999_999, pgid: null }]);
        expect(calls).toHaveLength(1);
    });

    it("jobAlive 只看根进程；facts 明说寿命边界", () => {
        const os = createWin32Os(deps({}));
        expect(os.jobAlive(process.pid)).toBe(true);
        expect(os.jobAlive(999_999)).toBe(false);
        expect(os.facts().join("\n")).toContain("根进程");
    });

    it("hopSync：祖先链 4 跳共用一次全量快照（不逐 pid 起进程，R9 修订）", () => {
        let scans = 0;
        const os = createWin32Os({
            ...deps({}),
            runSync: (_cmd, args) => {
                const script = args[args.length - 1] ?? "";
                if (script.includes("Win32_Process")) return CIM_MANY;
                scans += 1; // wmic 全量
                return "";
            },
        });
        expect(os.hopSync(4200)?.ppid).toBe(1);
        expect(os.hopSync(4210)?.ppid).toBe(4200);
        expect(scans).toBe(1);
    });

    it("probe：连接恒空是**声明过的能力缺失**（caps=false + facts），不是装作采到", () => {
        const os = createWin32Os({ ...deps({}), runSync: (_cmd, args) => ((args[args.length - 1] ?? "").includes("Win32_Process") ? CIM_MANY : "") });
        const p = os.probe(4200);
        expect(p.connections).toEqual([]);
        expect(p.rssKb).toBe(2);
        expect(os.caps.tcpConnections).toBe(false);
        expect(os.facts().join("\n")).toContain("不采集 TCP 连接");
    });

    it("snapshot 优先 wmic（比 PowerShell 冷启动快一个数量级），空输出才回退 CIM", async () => {
        const list = [
            "CommandLine=node a.js",
            "CreationDate=20261031060000.000000+000",
            "ParentProcessId=1",
            "ProcessId=4200",
            "WorkingSetSize=2048",
            "",
        ].join("\r\n");
        const races: string[] = [];
        const os = createWin32Os({
            ...deps({}),
            run: async (cmd) => {
                races.push(cmd);
                return cmd === "wmic" ? list : "";
            },
        });
        const rows = await os.snapshot();
        expect(races).toEqual(["wmic"]);
        expect(rows?.[0]).toMatchObject({ pid: 4200, pgid: null, command: "node a.js" });
    });

    it("ownProcesses：pgid=null 时走 PPID 锚点（lineage）+ createdAt 时间窗", async () => {
        const at = 1_000_000;
        const rows = [
            { pid: 501, ppid: 500, pgid: null, command: "sleep 600", etimeText: "01:00", pcpu: 0, rssKb: null, createdAt: at + 100 },
        ];
        const cim = JSON.stringify(
            rows.map((r) => ({
                ProcessId: r.pid,
                ParentProcessId: r.ppid,
                CommandLine: r.command,
                CreationDate: `/Date(${r.createdAt})/`,
                WorkingSetSize: 0,
            })),
        );
        const os = createWin32Os({ ...deps({}), run: async () => cim });
        const got = await os.ownProcesses({
            selfPid: 100,
            groups: new Map([[500, { at, command: "bash -c 'nohup sleep 600 &'", cwd: "/tmp", runId: "r-1" }]]),
            runPids: new Map([[500, "r-1"]]),
        });
        expect(got.ok).toBe(true);
        expect(got.procs[0]).toMatchObject({ pid: 501, claim: "lineage", anchorPid: 500, runId: "r-1" });
        // live：锚点 500 不在快照，但 501 被 lineage 认领 ⇒ 保留锚点；未登记的号不进来
        expect(got.live.has(500)).toBe(true);
        expect(got.live.has(999)).toBe(false);
    });
});
