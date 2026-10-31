// 🎯 OS 级能力的**契约**（纯类型 + 纯数据，不含任何平台分支）
//
// 用户 2026-10-31 定的架构规则：
//   · 不对系统做假设的代码是 **OS 无关**的；它只依赖这里的接口。
//   · 任何系统假设（`ps` 的列、`/bin/bash`、进程组、`taskkill`、`osascript`…）
//     必须落在 `os/posix.ts` 或 `os/win32.ts` 里，**不许出现在别的文件**。
//   · 唯一允许看 `process.platform` 的地方是 `os/index.ts` 的策略选型。
//
// 所以这个文件只放「两边都能满足的形状」；某一边满足不了的用 `caps` 明说
// （调用方据此降级，而不是猜平台）。

import type { OwnedProc, GroupOwner } from "../../shared/proc-scan";
import type { ConnectionInfo } from "../../shared/process-health";

/** 一次 shell 能力探测的结果（bash / pwsh 是**两种能力**，语法与退出码语义都不同）。 */
export interface ShellSpec {
    /** 能力种类：决定工具名（`bash` / `pwsh`）与命令拼装方式 */
    kind: "bash" | "pwsh";
    /** 可执行文件路径 */
    file: string;
    /** 给人看的名字（错误文案里用） */
    label: string;
    /** 本平台确实没找到这个能力 */
    missing: boolean;
    /** 找过哪些位置（`missing` 时写进错误文案） */
    tried: string[];
}

/** 进程表的一行（策略层归一化后的形状；列名不带任何 ps 痕迹）。 */
export interface ProcessRow {
    pid: number;
    ppid: number;
    /**
     * 进程组 id。
     * POSIX：真实 pgid；Windows 没有这个概念 ⇒ **null**（R4：cap 必须与数据形状一致）。
     * 认领/寿命改走 PPID 锚点与根进程（见 win32.ts 头注）。
     */
    pgid: number | null;
    /** 完整命令行 */
    command: string;
    /** `[[dd-]hh:]mm:ss`；采不到为空串 */
    etimeText: string;
    /** 瞬时 CPU%（采不到 null） */
    pcpu: number | null;
    /** 常驻内存 KiB（采不到 null） */
    rssKb: number | null;
    /** 进程创建时刻（epoch ms；采不到 null/缺省）。Windows 的 pid 复用闸靠它。 */
    createdAt?: number | null;
}

/** 父进程一跳（实例溯源用）。 */
export interface ProcessHop {
    pid: number;
    ppid: number;
    command: string;
}

/** 一棵进程树的聚合视图（OS 无关的判据在 shared/process-health.ts）。 */
export interface ProcessTree {
    readonly directChildCount: number;
    readonly descendants: readonly { pid: number; command: string }[];
    readonly treeCpuPercent: number;
}

/** GPU 能力探测结果（目前只有 macOS 的 Metal 字段有实际含义）。 */
export interface GpuInfo {
    metalFamily: number;
    gpuName: string;
    shouldUseAngle: boolean;
}

/** 平台能力声明：调用方按能力降级，**不许按平台名分支**。 */
export interface OsCapabilities {
    /** 有 POSIX 进程组语义（`kill(-pgid)`） */
    readonly processGroups: boolean;
    /** 能批量取进程的环境变量 */
    readonly processEnvironments: boolean;
    /** 能取 TCP 连接（lsof / Get-NetTCPConnection） */
    readonly tcpConnections: boolean;
    /** 能探测 GPU 细节 */
    readonly gpu: boolean;
    /** 能把别的实例窗口置前（系统级降级） */
    readonly focusProcess: boolean;
    /** 关掉所有窗口后进程继续常驻（macOS Dock 语义） */
    readonly keepRunningOnWindowClose: boolean;
    /**
     * 后台 run 必须让 shell 自己把输出重定向到日志（不能把父进程 fd 当 stdio）。
     * 已知：Windows 的 Git Bash（MSYS）会静默丢弃 Node 传入的文件句柄。
     */
    readonly shellRedirectsLog: boolean;
    /**
     * 后台 run 的寿命判据：
     *   · `groups` = 进程组里还有活口就算活着（POSIX）
     *   · `root`   = 只跟根进程（Windows；根退子活会被判成已结束，UI 要如实说）
     */
    readonly runLifetime: "groups" | "root";
    /**
     * 有没有可捕获的终止信号（SIGTERM → 宽限期 → SIGKILL）。
     * Windows 的 TerminateProcess 没有收尾窗口，两段杀只会白等一个 KILL_GRACE_MS。
     */
    readonly gracefulSignals: boolean;
    /**
     * 脱组孤儿怎么认领：
     *   · `groups`   = 进程组（POSIX）
     *   · `lineage`  = PPID 链命中已登记的根 pid（Windows 不 reparent，父链仍指向死掉的根）
     *   · `none`     = 认不出来（能力缺失时如实说）
     */
    readonly orphanRecovery: "groups" | "lineage" | "none";
}

/** 一次进程现场采集（**观测类**，不是机制；R2 修订后允许在 L2 出现）。 */
export interface ProcessProbe {
    /** 已运行时长（ms；采不到 null） */
    runMs: number | null;
    /** 瞬时 CPU%（采不到 null） */
    cpuPercent: number | null;
    /** 树聚合（采不到 null） */
    tree: ProcessTree | null;
    /** TCP 连接（能力不支持时为空数组，且 `caps.tcpConnections === false` + facts 明说） */
    connections: ConnectionInfo[];
    /** 常驻内存 KiB（采不到 null） */
    rssKb: number | null;
}

/** `ownProcesses()` 的输入：调用方只给事实（自己的 pid、两组登记表），不给机制。 */export interface OwnQuery {
    /** app 主进程 pid（它的子孙也算我们起的） */
    selfPid: number;
    /** 我们记过的进程组（POSIX pgid / Windows 根 pid） */
    groups: ReadonlyMap<number, GroupOwner>;
    /** run 根进程 pid → runId */
    runPids: ReadonlyMap<number, string>;
}

/** `ownProcesses()` 的输出：**意图结果**（谁归我们管）+ 回收名册要的现存组号。 */
export interface OwnedSnapshot {
    /** 本轮快照是否成功（失败时 procs 为空，调用方要如实说「没扫到」） */
    ok: boolean;
    procs: OwnedProc[];
    /** 现存的组号（POSIX pgid / Windows 根 pid），供名册回收 */
    live: Set<number>;
}

/** OS 级能力的唯一入口。实现见 `posix.ts` / `win32.ts`；选型见 `index.ts`。 */
export interface OsStrategy {
    /** 只是给人看的诊断标签（**判据请用 caps，别用这个**） */
    readonly kind: "posix" | "windows";
    readonly caps: OsCapabilities;

    // ── shell 能力（可能并存：Windows = pwsh + 可选 Git Bash）──
    /**
     * 本机可用的 shell 能力（首选在前；空数组 = 都没有）。**同步**是契约：
     * `runBash` 的 `onControl`（转后台交接）必须在调用当拍完成。
     */
    resolveShells(): ShellSpec[];

    // ── L2 意图（业务只调这 4 个）──
    /** 「我们起的那些进程」：认领 + 时间窗 + 观测工具自排除，全部在实现里 */
    ownProcesses(query: OwnQuery): Promise<OwnedSnapshot>;
    /** 「收掉它们」：不返回结果（R3），调用方统一说「已发出结束请求」 */
    killOwned(targets: readonly { pid: number; pgid?: number | null }[], signal?: NodeJS.Signals): void;
    /** 「这个作业还活着吗」：POSIX 看组、Windows 看根进程（facts 里明说差异） */
    jobAlive(pid: number): boolean;
    /** 能力/寿命差异的**事实句**（给人看；UI / `job ps` 直接展示） */
    facts(): string[];

    // ── 观测（意图与保证两边相同，允许归一到 L2）──
    /** 全机快照（同步版：现有启动 / 守卫路径本来就是同步的） */
    snapshotSync(): ProcessRow[] | null;
    /** 全机快照（异步版：面板 / 工具路径用，不阻塞主进程） */
    snapshot(): Promise<ProcessRow[] | null>;
    /** 父进程一跳 */
    hopSync(pid: number): ProcessHop | null;
    /** 单进程现场（时长 / CPU / 树 / 连接 / 内存）；观测类，供 process-health 用 */
    probe(pid: number): ProcessProbe;

    // ── 系统能力（非进程意图，但需要平台实现）──
    gpu(): GpuInfo;
    focusProcess(pid: number): boolean;
}
