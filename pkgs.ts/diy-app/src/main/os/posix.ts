// 🎯 POSIX 策略（Linux / macOS 共用；macOS 的额外能力用 caps 声明）
//
// 这个文件是**唯一**允许出现 `ps` / `top` / `lsof` / `osascript` / `system_profiler`
// 这些系统假设的地方（见 os/types.ts 头注）。外部只拿归一化后的数据。

import { execFile, execFileSync } from "node:child_process";
import type { ConnectionInfo } from "../../shared/process-health";
import { selectOwnedProcs } from "../../shared/proc-scan";
import { parseEtime } from "./duration";
import { aggregateTree } from "./tree";
import { registeredLive } from "./live";
import type {
    GpuInfo,
    OsStrategy,
    ProcessHop,
    ProcessRow,
    ProcessTree,
    ShellSpec,
} from "./types";

export { parseEtime } from "./duration";

/** 注入点：单测喂固定文本夹具，不真跑系统命令。 */
export interface PosixDeps {
    /** 同步执行并返回 stdout；失败/非零退出一律返回 ""（观测失败退化成"看不见"，不许炸业务）。 */
    runSync(cmd: string, args: readonly string[], timeoutMs?: number): string;
    /** 异步版（同上，失败返回 ""） */
    run(cmd: string, args: readonly string[], timeoutMs?: number): Promise<string>;
    /** 动作路径用：执行并返回**是否成功**（失败不吞成空串，见 focusProcess） */
    tryRunSync(cmd: string, args: readonly string[], timeoutMs?: number): boolean;
    /** 平台细分：只有 macOS 才有的能力（top -l 2 / osascript / system_profiler） */
    platform: NodeJS.Platform;
    now(): number;
}

export function defaultPosixDeps(platform: NodeJS.Platform = process.platform): PosixDeps {
    return {
        runSync(cmd, args, timeoutMs = 3000) {
            try {
                return execFileSync(cmd, args as string[], {
                    encoding: "utf-8",
                    timeout: timeoutMs,
                    stdio: ["ignore", "pipe", "ignore"],
                    maxBuffer: 16 * 1024 * 1024,
                });
            } catch {
                return "";
            }
        },
        run(cmd, args, timeoutMs = 3000) {
            return new Promise<string>((resolve) => {
                execFile(
                    cmd,
                    args as string[],
                    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
                    (err, stdout) => resolve(err ? "" : (stdout ?? "")),
                );
            });
        },
        tryRunSync(cmd, args, timeoutMs = 3000) {
            try {
                execFileSync(cmd, args as string[], {
                    timeout: timeoutMs,
                    stdio: ["ignore", "pipe", "ignore"],
                });
                return true;
            } catch {
                return false;
            }
        },
        platform,
        now: () => Date.now(),
    };
}

// ═══════════════════════════════════════
// 解析器（导出的原因：单测直接喂文本）
// ═══════════════════════════════════════

/** `ps -axo pid=,ppid=,pgid=,etime=,pcpu=,rss=,command=` 的一行。 */
export function parseProcRows(stdout: string): ProcessRow[] {
    const out: ProcessRow[] = [];
    for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        const cpu = Number(m[5]);
        out.push({
            pid,
            ppid: Number(m[2]),
            pgid: Number(m[3]),
            etimeText: m[4] ?? "",
            pcpu: Number.isFinite(cpu) ? cpu : null,
            rssKb: Number(m[6]) || null,
            command: (m[7] ?? "").trim(),
        });
    }
    return out;
}

/** `ps -Ao pid=,ppid=,command=` 的一行（实例发现用；表头/空行/畸形行一律跳过）。 */
export function parseBasicRows(stdout: string): ProcessHop[] {
    const out: ProcessHop[] = [];
    for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        const command = (m[3] ?? "").trim();
        if (!Number.isFinite(pid) || !command) continue;
        out.push({ pid, ppid: Number(m[2]), command });
    }
    return out;
}

/** `ps -p <pid> -o pid=,ppid=,command=` → 一跳。 */
export function parseHop(stdout: string): ProcessHop | null {
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), command: (m[3] ?? "").trim() };
}

/**
 * `ps eww -p a,b,c` → pid → 环境变量。
 * 行格式：`  PID  TT  STAT   TIME  COMMAND ENV=… ENV=…`（`ps eww` 无法抑制表头，跳过非数据行）。
 */
export function parseEnvironments(stdout: string): Map<number, Record<string, string>> {
    const out = new Map<number, Record<string, string>>();
    for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
        if (!m) continue;
        const env: Record<string, string> = {};
        for (const tok of (m[2] ?? "").split(/\s+/)) {
            const eq = tok.indexOf("=");
            if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1);
        }
        out.set(Number(m[1]), env);
    }
    return out;
}

/** `top -l 2 ...` 的输出 → 该 pid 的**瞬时** CPU 百分比（取最后一块表头之后）。 */
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

/** `ps -axo pid=,ppid=,pcpu=,comm=` → 从 `rootPid` 起算的树聚合。 */
export function parseProcessTree(stdout: string, rootPid: number): ProcessTree {
    const nodes: { pid: number; ppid: number; pcpu: number; command: string }[] = [];
    for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
        if (!m) continue;
        nodes.push({ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]) || 0, command: m[4].trim() });
    }
    return aggregateTree(nodes, rootPid);
}

/** `lsof -nP -a -p <pid> -iTCP` → 连接（含状态；没有 REMOTE 的 LISTEN 行也保留）。 */
export function parseLsofTcp(stdout: string): ConnectionInfo[] {
    const out: ConnectionInfo[] = [];
    for (const line of stdout.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 8) continue;
        const state = cols[cols.length - 1];
        const remote = cols[cols.length - 2];
        if (!state.startsWith("(")) continue;
        out.push({ remote, state: state.replace(/[()]/g, "") });
    }
    return out;
}

/** `system_profiler SPDisplaysDataType` → Metal 能力。非 macOS 一律默认值。 */
export function parseGpuInfo(stdout: string): GpuInfo {
    const metalMatch = stdout.match(/Metal Family:.*?Metal GPUFamily macOS (\d+)/);
    const family = metalMatch ? parseInt(metalMatch[1]!, 10) : 99;
    const gpuMatch = stdout.match(/Chipset Model:\s*(.+)/);
    const gpuName = gpuMatch?.[1]?.trim() ?? "unknown";
    return { metalFamily: family, gpuName, shouldUseAngle: family < 3 };
}

// ═══════════════════════════════════════
// 策略
// ═══════════════════════════════════════

const PS_ARGS = ["-axo", "pid=,ppid=,pgid=,etime=,pcpu=,rss=,command="] as const;

/** 「这是观测工具自己」：POSIX 是 ps 全表那条命令。 */
function isObserverCommand(command: string): boolean {
    return command.startsWith("ps -axo pid=,ppid=,pgid=");
}

export function createPosixOs(deps: PosixDeps = defaultPosixDeps()): OsStrategy {
    const mac = deps.platform === "darwin";
    let gpuCache: GpuInfo | undefined;

    const withCreatedAt = (rows: ProcessRow[]): ProcessRow[] => {
        const at = deps.now();
        return rows.map((r) => {
            const elapsed = parseEtime(r.etimeText);
            return { ...r, createdAt: elapsed === null ? null : at - elapsed };
        });
    };

    const snapshotSync = (): ProcessRow[] | null => {
        const text = deps.runSync("ps", PS_ARGS, 5000);
        return text.trim() ? withCreatedAt(parseProcRows(text)) : null;
    };

    return {
        kind: "posix",
        caps: {
            processGroups: true,
            processEnvironments: true,
            tcpConnections: true,
            gpu: mac,
            focusProcess: mac,
            keepRunningOnWindowClose: mac,
            shellRedirectsLog: false,
            runLifetime: "groups",
            gracefulSignals: true,
            orphanRecovery: "groups",
        },

        resolveShells(): ShellSpec[] {
            return [{ kind: "bash", file: "/bin/bash", label: "/bin/bash", missing: false, tried: ["/bin/bash"] }];
        },

        async ownProcesses(query) {
            const rows = await this.snapshot();
            if (!rows) return { ok: false, procs: [], live: new Set() };
            const procs = selectOwnedProcs(rows, { ...query, now: deps.now(), isObserver: isObserverCommand });
            return { ok: true, procs, live: registeredLive(query, rows, procs) };
        },

        killOwned(targets, signal = "SIGTERM") {
            for (const t of targets) {
                const pid = t.pid;
                if (!Number.isInteger(pid) || pid <= 0) continue;
                const group = t.pgid ?? pid;
                try {
                    // 组长在就杀整组；不是组长（`-pid` ESRCH）就只杀它自己 —— 避开 app 自己的组
                    process.kill(-group, signal);
                } catch {
                    try {
                        process.kill(pid, signal);
                    } catch {
                        // 已回收：无可杀
                    }
                }
            }
        },

        jobAlive(pid) {
            if (!Number.isInteger(pid) || pid <= 0) return false;
            try {
                process.kill(-pid, 0);
                return true;
            } catch (e) {
                return (e as NodeJS.ErrnoException).code === "EPERM";
            }
        },

        facts() {
            return ["POSIX：后台作业按进程组判活（根进程退出后，组里还有活口就仍算运行中）"];
        },

        snapshotSync,

        async snapshot() {
            const text = await deps.run("ps", PS_ARGS, 5000);
            return text.trim() ? withCreatedAt(parseProcRows(text)) : null;
        },

        hopSync(pid) {
            if (!Number.isInteger(pid) || pid <= 1) return null;
            return parseHop(deps.runSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], 2000));
        },

        probe(pid) {
            const runMs = parseEtime(deps.runSync("ps", ["-o", "etime=", "-p", String(pid)], 3000));
            const cpuPercent = mac
                ? (parseTopCpu(
                      deps.runSync(
                          "top",
                          ["-l", "2", "-pid", String(pid), "-stats", "pid,cpu,time,command"],
                          5000,
                      ),
                      pid,
                  ) ?? 0)
                : Number(deps.runSync("ps", ["-o", "%cpu=", "-p", String(pid)], 3000).trim()) || 0;
            const tree = parseProcessTree(deps.runSync("ps", ["-axo", "pid=,ppid=,pcpu=,comm="], 5000), pid);
            const connections = parseLsofTcp(deps.runSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP"], 3000));
            const rss = Number(deps.runSync("ps", ["-o", "rss=", "-p", String(pid)], 3000).trim());
            return { runMs, cpuPercent, tree, connections, rssKb: Number.isFinite(rss) && rss > 0 ? rss : null };
        },

        gpu() {
            if (gpuCache) return gpuCache;
            const neutral: GpuInfo = { metalFamily: 99, gpuName: "unknown", shouldUseAngle: false };
            if (!mac) {
                gpuCache = neutral;
                return gpuCache;
            }
            const text = deps.runSync("system_profiler", ["SPDisplaysDataType"], 3000);
            if (!text.trim()) {
                console.log("[gpu] GPU 检测失败（system_profiler 不可用），跳过");
                gpuCache = neutral;
                return gpuCache;
            }
            gpuCache = parseGpuInfo(text);
            console.log(`[gpu] GPU: ${gpuCache.gpuName} (Metal GPUFamily macOS ${gpuCache.metalFamily})`);
            if (gpuCache.shouldUseAngle) {
                console.log("[gpu] Metal GPUFamily < 3，添加 --use-gl=angle（防御性，非 rust_png 崩溃的修复）");
            }
            return gpuCache;
        },

        focusProcess(pid) {
            if (!mac) return false;
            return deps.tryRunSync(
                "osascript",
                [
                    "-e",
                    `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
                ],
                3000,
            );
        },
    };
}
