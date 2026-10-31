// 🎯 Windows 策略
//
// 这个文件是**唯一**允许出现 `powershell` / `taskkill` / `bash.exe` 这些 Windows 假设的地方
// （见 os/types.ts 头注）。外部只拿归一化后的数据。
//
// 与 POSIX 的已知差异（都用 caps 明说，不在调用方猜）：
//   · 没有进程组 → `pgid` 一律是 **null**（R4）；认领孤儿走 PPID 锚点，杀进程走 `taskkill /T /F`。
//     `treeAlive` 因此只能判根进程（没有便宜的"按进程组枚举"手段）。
//   · 没有 `ps eww` → 取不到环境变量（`processEnvironments: false`）。
//   · `lsof` 不对应 → 不采 TCP 连接（`tcpConnections: false`）。
//   · `system_profiler` / `osascript` 不对应 → GPU / 系统级前置返回空实现。
//   · Git Bash（MSYS）会丢掉 Node 传入的文件句柄 → 后台 run 必须让 shell 自己重定向日志
//     （`shellRedirectsLog: true`）。

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as winPath } from "node:path";
import { formatEtime } from "./duration";
import { aggregateTree } from "./tree";
import { selectOwnedProcs } from "../../shared/proc-scan";
import { registeredLive } from "./live";
import type {
    GpuInfo,
    OsStrategy,
    ProcessRow,
    ShellSpec,
} from "./types";

/** 注入点：单测喂固定 JSON 夹具 / 假 shell 探测，不真跑 PowerShell。 */
export interface Win32Deps {
    runSync(cmd: string, args: readonly string[], timeoutMs?: number): string;
    run(cmd: string, args: readonly string[], timeoutMs?: number): Promise<string>;
    tryRunSync(cmd: string, args: readonly string[], timeoutMs?: number): boolean;
    /** 起一个分离的子进程（taskkill）；返回是否**已发出**（不承诺进程已死） */
    spawnDetached(cmd: string, args: readonly string[]): boolean;
    /** 文件存在性（同步；缺省 `existsSync`，单测注入） */
    exists(path: string): boolean;
    env: NodeJS.ProcessEnv;
    now(): number;
}

const PS = "powershell.exe";
const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/** PowerShell 脚本前置：强制 UTF-8 输出（否则中文路径在重定向时会按 OEM 码页乱码）。 */
const PS_UTF8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";

const SNAPSHOT_SCRIPT =
    PS_UTF8 +
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object " +
    "ProcessId,ParentProcessId,CommandLine,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime | " +
    "ConvertTo-Json -Compress -Depth 2";

/**
 * WMIC 的列（`/format:list`）。为什么优先用它：PowerShell 冷启动约 2.6s，
 * WMIC 全量快照约 0.3s —— 启动时父链快照要连查 4 跳，差一个数量级。
 * WMIC 在新版 Windows 上已被移除，所以**跑空就回退 PowerShell**（见 snapshotSync）。
 */
const WMIC_ARGS = [
    "process",
    "get",
    "ProcessId,ParentProcessId,CommandLine,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime",
    "/format:list",
] as const;

/** 同步快照缓存窗口：父链要连查 4 跳，4 次各跑一遍系统命令会把启动拖慢一个数量级。 */
const SNAPSHOT_CACHE_MS = 2_000;
/** R9：同步取数的唯一常量超时（不设预算参数）。超时返回 null，主进程不许等冷启动 PowerShell。 */
const SYNC_TIMEOUT_MS = 2_000;

export function defaultWin32Deps(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): Win32Deps {
    return {
        runSync(cmd, args, timeoutMs = 5000) {
            try {
                return execFileSync(cmd, args as string[], {
                    encoding: "utf-8",
                    timeout: timeoutMs,
                    stdio: ["ignore", "pipe", "ignore"],
                    maxBuffer: 32 * 1024 * 1024,
                    windowsHide: true,
                });
            } catch {
                return "";
            }
        },
        run(cmd, args, timeoutMs = 5000) {
            return new Promise<string>((resolve) => {
                execFile(
                    cmd,
                    args as string[],
                    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
                    (err, stdout) => resolve(err ? "" : (stdout ?? "")),
                );
            });
        },
        tryRunSync(cmd, args, timeoutMs = 3000) {
            try {
                execFileSync(cmd, args as string[], {
                    timeout: timeoutMs,
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: true,
                });
                return true;
            } catch {
                return false;
            }
        },
        spawnDetached(cmd, args) {
            try {
                const child = spawn(cmd, args as string[], { stdio: "ignore", windowsHide: true });
                child.on("error", () => {});
                child.unref();
                return true;
            } catch {
                // 无可杀（与 POSIX 的 catch 同口径）
                return false;
            }
        },
        // sync-io-ok: shell 路径解析必须在同步窗口内完成（runBash 的 onControl 交接契约），
        // 且整个进程只探测这几个固定路径一次（缓存见 os/shell.ts）。
        exists: (path) => existsSync(path),
        env,
        now,
    };
}

/** `YYYYMMDDHHMMSS.mmmmmm+UUU`（WMIC 的 DMTF 时间）→ ms。认不出 = null。 */
function parseDmtf(raw: string): number | null {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d{3})$/.exec(raw.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s, frac, tz] = m;
    const offsetMin = Number(tz);
    const utc =
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.slice(0, 3))) -
        offsetMin * 60_000;
    return Number.isFinite(utc) ? utc : null;
}

/** wmic 的 `/format:list` 会把命令行里的 XML 元字符转义；还原后再交给上层匹配。 */
function decodeWmic(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * `wmic process get … /format:list` → 归一化进程行。
 *
 * 输出是「空行分隔的 key=value 块」，顺序不保证；值里可能有 `=`（CommandLine），
 * 所以只在**第一个** `=` 处切。
 */
export function parseWmicRows(stdout: string, now: number = Date.now()): ProcessRow[] {
    const out: ProcessRow[] = [];
    let cur: Record<string, string> = {};
    const flush = (): void => {
        const pid = Number(cur["ProcessId"]);
        if (Number.isInteger(pid) && pid > 0) {
            const created = cur["CreationDate"] ? parseDmtf(cur["CreationDate"]) : null;
            const elapsed = created === null ? null : Math.max(0, now - created);
            const cpu100ns = Number(cur["KernelModeTime"] ?? 0) + Number(cur["UserModeTime"] ?? 0);
            const cpu =
                elapsed !== null && elapsed > 0 && Number.isFinite(cpu100ns)
                    ? Math.round((cpu100ns / 1e7 / (elapsed / 1000)) * 1000) / 10
                    : null;
            const rss = Number(cur["WorkingSetSize"]);
            out.push({
                pid,
                ppid: Number(cur["ParentProcessId"]) || 0,
                pgid: null, // Windows 没有进程组（R4：cap 与数据形状一致）
                command: decodeWmic(cur["CommandLine"] ?? "").trim(),
                etimeText: elapsed === null ? "" : formatEtime(elapsed),
                pcpu: cpu,
                rssKb: Number.isFinite(rss) && rss > 0 ? Math.floor(rss / 1024) : null,
                createdAt: created,
            });
        }
        cur = {};
    };
    for (const line of stdout.split(/\r?\n/)) {
        if (line.trim() === "") {
            flush();
            continue;
        }
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        cur[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    flush();
    return out;
}

// ═══════════════════════════════════════
// 解析器（导出的原因：单测直接喂文本）
// ═══════════════════════════════════════

interface CimRow {
    ProcessId?: number | string;
    ParentProcessId?: number | string;
    CommandLine?: string | null;
    CreationDate?: unknown;
    WorkingSetSize?: number | string | null;
    KernelModeTime?: number | string | null;
    UserModeTime?: number | string | null;
}

/** `/Date(1234567890+0800)/` / ISO 字符串 / 数字 → ms。认不出 = null。 */
function createdAtOf(raw: unknown): number | null {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== "string" || !raw) return null;
    const ms = /\/Date\((-?\d+)([+-]\d+)?\)\//.exec(raw);
    if (ms) return Number(ms[1]);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

/** `Get-CimInstance Win32_Process | ConvertTo-Json` → 归一化进程行。 */
export function parseCimRows(stdout: string, now: number = Date.now()): ProcessRow[] {
    if (!stdout.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return [];
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const out: ProcessRow[] = [];
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const r = item as CimRow;
        const pid = Number(r.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const created = createdAtOf(r.CreationDate);
        const elapsed = created === null ? null : Math.max(0, now - created);
        const cpu100ns = Number(r.KernelModeTime ?? 0) + Number(r.UserModeTime ?? 0);
        const cpu =
            elapsed !== null && elapsed > 0 && Number.isFinite(cpu100ns)
                ? Math.round((cpu100ns / 1e7 / (elapsed / 1000)) * 1000) / 10
                : null;
        const rss = Number(r.WorkingSetSize);
        out.push({
            pid,
            ppid: Number(r.ParentProcessId) || 0,
            // Windows 没有进程组：null 而不是拿 pid 冒充（R4）
            pgid: null,
            command: (r.CommandLine ?? "").trim(),
            etimeText: elapsed === null ? "" : formatEtime(elapsed),
            pcpu: cpu,
            rssKb: Number.isFinite(rss) && rss > 0 ? Math.floor(rss / 1024) : null,
            createdAt: created,
        });
    }
    return out;
}

/** Windows 上 bash 的候选顺序（Git for Windows → 用户级安装 → scoop → PATH）。 */
export function shellCandidates(env: NodeJS.ProcessEnv): string[] {
    const out: string[] = [];
    const add = (p: string | undefined): void => {
        if (p && p.trim()) out.push(p);
    };
    add(env["DIY_SHELL"]);
    const gitBin = (...root: Array<string | undefined>): string | undefined => {
        const base = root.filter((x): x is string => Boolean(x)).join("\\");
        return base ? winPath.join(base, "Git", "bin", "bash.exe") : undefined;
    };
    add(gitBin(env["ProgramFiles"]));
    add(gitBin(env["ProgramW6432"]));
    add(gitBin(env["ProgramFiles(x86)"]));
    add(env["LOCALAPPDATA"] ? winPath.join(env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe") : undefined);
    add(
        env["USERPROFILE"]
            ? winPath.join(env["USERPROFILE"], "scoop", "apps", "git", "current", "bin", "bash.exe")
            : undefined,
    );
    for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
        const d = dir.trim().replace(/^"|"$/g, "");
        // System32 里的 bash.exe 是 WSL 启动桩，语义不同，不自动用
        if (!d || /[\\/]system32[\\/]?$/i.test(d) || /[\\/]syswow64[\\/]?$/i.test(d)) continue;
        add(winPath.join(d, "bash.exe"));
    }
    return [...new Set(out)];
}

/** Windows 上 pwsh 的候选（优先 PowerShell 7，最后才是 5.1）。 */
export function pwshCandidates(env: NodeJS.ProcessEnv): string[] {
    const out: string[] = [];
    const add = (p: string | undefined): void => {
        if (p && p.trim()) out.push(p);
    };
    for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
        const d = dir.trim().replace(/^"|"$/g, "");
        if (!d) continue;
        add(winPath.join(d, "pwsh.exe"));
    }
    add(env["ProgramFiles"] ? winPath.join(env["ProgramFiles"], "PowerShell", "7", "pwsh.exe") : undefined);
    add(env["SystemRoot"] ? winPath.join(env["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined);
    for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
        const d = dir.trim().replace(/^"|"$/g, "");
        if (!d) continue;
        add(winPath.join(d, "powershell.exe"));
    }
    return [...new Set(out)];
}

/** 按可执行文件名判定能力种类（bash/sh vs pwsh/powershell）。 */
function shellKindOf(file: string): "bash" | "pwsh" {
    return /(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/i.test(file) ? "bash" : "pwsh";
}

/**
 * Windows 的 shell 能力探测（R6/R7）：`DIY_SHELL` → Git Bash 已知位置 → `pwsh.exe` → `powershell.exe`。
 * **bash 缺席不是错误** —— 有 pwsh 就够用；两者都有时都返回（工具面并存）。
 */
export function discoverShellSpecs(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): ShellSpec[] {
    const diy = (env["DIY_SHELL"] ?? "").trim();
    // 显式 DIY_SHELL 是**权威覆盖**：设了（哪怕指错）就不再猜 Git Bash ——
    // 这样「把 bash 关掉看 pwsh 降级」是可复现的，而不是"指错也照样找到 Git Bash"。
    const bashList = diy ? [diy] : shellCandidates(env);
    const tried = [...bashList, ...pwshCandidates(env)];
    const out: ShellSpec[] = [];
    const seen = new Set<string>();
    for (const file of tried) {
        const key = file.toLowerCase();
        if (seen.has(key) || !exists(file)) continue;
        seen.add(key);
        out.push({ kind: shellKindOf(file), file, label: file, missing: false, tried });
    }
    return out;
}

/** 「这是观测工具自己」：两种取数方式（wmic 优先 / CIM 回退）各自会出现在自己的快照里。 */
function isObserverCommand(command: string): boolean {
    return /Get-CimInstance\s+Win32_Process/i.test(command) || /\bwmic(?:\.exe)?\s+process\b/i.test(command);
}

/** 策略 */

export function createWin32Os(deps: Win32Deps = defaultWin32Deps()): OsStrategy {
    const readSnapshotSync = (): ProcessRow[] | null => {
        const now = deps.now();
        // 同步路径的预算是硬约束：主进程等「看不见」远好过等 4s。wmic 正常 0.3s，
        // 24H2 起 wmic 被移除时 CIM 冷启动可到 4s —— 常量 2s 到点就放弃（返回 null，见 R9）。
        const wmic = parseWmicRows(deps.runSync("wmic", WMIC_ARGS, SYNC_TIMEOUT_MS), now);
        if (wmic.length > 0) return wmic;
        const cim = parseCimRows(deps.runSync(PS, [...PS_FLAGS, SNAPSHOT_SCRIPT], SYNC_TIMEOUT_MS), now);
        return cim.length > 0 ? cim : null;
    };

    let cache: { at: number; rows: ProcessRow[] | null } | undefined;
    const snapshotSync = (): ProcessRow[] | null => {
        const now = deps.now();
        if (cache && now - cache.at < SNAPSHOT_CACHE_MS) return cache.rows;
        const rows = readSnapshotSync();
        cache = { at: now, rows };
        return rows;
    };

    // 异步路径：面板 3s 一刷不能叠出多个 PowerShell；短 TTL + in-flight 合并。
    let asyncCache: { at: number; rows: ProcessRow[] | null } | undefined;
    let inflight: Promise<ProcessRow[] | null> | undefined;
    const readSnapshotAsync = async (): Promise<ProcessRow[] | null> => {
        const at = deps.now();
        const wmic = parseWmicRows(await deps.run("wmic", WMIC_ARGS, 4_000), at);
        if (wmic.length > 0) return wmic;
        const cim = parseCimRows(await deps.run(PS, [...PS_FLAGS, SNAPSHOT_SCRIPT], 8_000), at);
        return cim.length > 0 ? cim : null;
    };

    return {
        kind: "windows",
        caps: {
            processGroups: false,
            processEnvironments: false,
            tcpConnections: false,
            gpu: false,
            focusProcess: false,
            keepRunningOnWindowClose: false,
            shellRedirectsLog: true,
            runLifetime: "root",
            gracefulSignals: false,
            orphanRecovery: "lineage",
        },

        resolveShells(): ShellSpec[] {
            return discoverShellSpecs(deps.env, deps.exists);
        },

        async ownProcesses(query) {
            const rows = await this.snapshot();
            if (!rows) return { ok: false, procs: [], live: new Set() };
            const procs = selectOwnedProcs(rows, { ...query, now: deps.now(), isObserver: isObserverCommand });
            return { ok: true, procs, live: registeredLive(query, rows, procs) };
        },

        killOwned(targets, _signal) {
            // Windows 没有可捕获的终止信号：一次 taskkill /T /F；已回收的 pid 不发（R3/R5）。
            for (const t of targets) {
                if (!pidAlive(t.pid)) continue;
                deps.spawnDetached("taskkill", ["/pid", String(t.pid), "/T", "/F"]);
            }
        },

        jobAlive(pid) {
            // 只能判根进程（见文件头）；根退子活是 Windows 的已知边界，facts() 里明说。
            return pidAlive(pid);
        },

        facts() {
            return [
                "Windows：后台作业寿命跟根进程；根退出后，子孙可能先报完成（另开任务做 Job Object 等价）",
                "Windows：结束进程走异步 taskkill，回执只代表「结束请求已发出」",
                "Windows：没有 Git Bash 时使用 pwsh 工具（PowerShell 语法，不是 bash）",
                "Windows：不采集 TCP 连接（进程健康判据少一项连接证据）",
            ];
        },

        snapshotSync,

        async snapshot() {
            const now = deps.now();
            if (asyncCache && now - asyncCache.at < SNAPSHOT_CACHE_MS) return asyncCache.rows;
            if (inflight) return inflight;
            const p = readSnapshotAsync().then((rows) => {
                asyncCache = { at: deps.now(), rows };
                return rows;
            });
            inflight = p;
            void p.finally(() => {
                if (inflight === p) inflight = undefined;
            });
            return p;
        },

        hopSync(pid) {
            if (!Number.isInteger(pid) || pid <= 1) return null;
            // R9 修订：需要多个 pid（祖先链 4 跳）时**一次全量 + 2s 缓存**，不逐 pid 起进程。
            const row = snapshotSync()?.find((r) => r.pid === pid);
            return row ? { pid: row.pid, ppid: row.ppid, command: row.command } : null;
        },

        probe(pid) {
            const rows = snapshotSync();
            const row = rows?.find((r) => r.pid === pid);
            return {
                runMs: row?.createdAt != null ? Math.max(0, deps.now() - row.createdAt) : null,
                cpuPercent: row?.pcpu ?? null,
                tree: rows ? aggregateTree(rows, pid) : null,
                // caps.tcpConnections === false；facts() 里明说「不采集」，不装作采到
                connections: [],
                rssKb: row?.rssKb ?? null,
            };
        },

        gpu(): GpuInfo {
            return { metalFamily: 99, gpuName: "unknown", shouldUseAngle: false };
        },

        focusProcess() {
            return false;
        },
    };
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}
