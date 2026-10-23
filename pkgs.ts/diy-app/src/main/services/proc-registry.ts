// 🎯 后台进程表（活体）—— ##408 刀 8
//
// 用户 2026-10-23 的口径：「**不要进程恢复、不要文件审计、不要历史数据**，先把核心业务
// 实现掉：让 llm 起一个后台进程，自己心里有数、随时能查是死是活，也能放心结束本轮、
// 等 job 完成时插话激活。」
//
// 于是这里**刻意最小**：
//   · 真源 = 内存里的 `Map`（app 退出即空；重启后不接管、不 reconcile、不写 jsonl）；
//   · 输出 = 子进程自己的 fd 直写 `$DIY_HOME/jobs/proc/<id>/out.log`（进程的产物，
//     不是账本；要看就 tail 它，不额外维护"日志管理"）；
//   · 判活 = 我们持有 `ChildProcess` 的 `close` 事件（不需要 ps 轮询、不需要定时器）；
//   · 收口 = 状态落到终态后，若这条进程是某个任务的工具调用起的，**投一条插话**唤醒它。
//
// 为什么不做定时器：判活靠事件，不靠 tick。整条链上没有任何 `setInterval`。
//
// 生命周期唯一的坑（写在这里，别再踩一遍）：
//   子进程 `detached: true` + `stdio: ["ignore", <fd>, <fd>]` —— **不给管道**。
//   给管道就必须等 EOF，而未 `setsid` 的子孙可能继续持有写端 ⇒ `close` 迟到（##418 同源）。
//   输出直落文件后，`close` 与"进程真的结束了"一一对应。

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_TAIL_BYTES, notifyText, tailOf, type ProcLike, type TailResult } from "../../shared/proc-status";
import { jobsDir } from "./job-ledger";

/** 进程的来源锚点：哪一轮、哪一步、哪个工具调用起的（`toolCallId` 是定位键）。 */
export interface ProcOrigin {
    taskUri: string;
    turnId?: string;
    stepId?: string;
    toolCallId?: string;
}

export interface ProcInfo extends ProcLike {
    /** 进程组 id（= pid，因为 `detached` = setsid）：kill 按组发，才杀得干净 */
    pid: number;
    cwd: string;
    logPath: string;
    origin?: ProcOrigin;
    /** 起不来时的原因（`failed` 专属） */
    error?: string;
    /** 结束通知是否已投递（防重复唤醒） */
    notified?: boolean;
}

export interface SpawnProcInput {
    command: string;
    cwd: string;
    origin?: ProcOrigin;
}

export interface ProcRegistryOptions {
    /** 进程产物根目录（缺省 `$DIY_HOME/jobs/proc`）；测试注入 tmpdir */
    rootDir?: string;
    /** 时钟（测试注入假钟） */
    now?: () => number;
    /** 结束通知出口（缺省不通知）；真实 app 由 local-agent 注册「插话」实现 */
    notifier?: (taskUri: string, text: string) => void;
}

/** 杀不及时的宽限期：先 SIGTERM（让它自己收尾），到这个点还在就 SIGKILL 整组。 */
export const KILL_GRACE_MS = 2_000;

function newProcId(now: number): string {
    return `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class ProcRegistry {
    private readonly procs = new Map<string, ProcInfo>();
    private readonly children = new Map<string, ChildProcess>();
    private readonly waiters = new Map<string, Array<(info: ProcInfo) => void>>();
    /** 我们主动杀过的 id：决定终态是 `killed` 还是 `exited` */
    private readonly killedByUs = new Set<string>();
    private readonly rootDir: string;
    private readonly now: () => number;
    private notifier?: (taskUri: string, text: string) => void;

    constructor(opts: ProcRegistryOptions = {}) {
        this.rootDir = opts.rootDir ?? join(jobsDir(), "proc");
        this.now = opts.now ?? Date.now;
        this.notifier = opts.notifier;
    }

    setNotifier(fn: ((taskUri: string, text: string) => void) | undefined): void {
        this.notifier = fn;
    }

    /**
     * 起一条后台进程并**当场**登记。
     *
     * 登记时刻 = `spawn` 返回那一刻 —— 这是本刀的要害：v1 的「惰性晋升」（跑够 10s 才承认）
     * 让"进程活着但表里没有"成为常态（用户实测抓到 85 分钟无痕）。现在只要起了就在表里。
     */
    spawn(input: SpawnProcInput): ProcInfo {
        const now = this.now();
        const id = newProcId(now);
        const dir = join(this.rootDir, id);
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "out.log");
        const info: ProcInfo = {
            id,
            pid: -1,
            command: input.command,
            cwd: input.cwd,
            state: "running",
            startedAt: now,
            logPath,
            ...(input.origin ? { origin: input.origin } : {}),
        };
        // 先登记再 spawn：spawn 同步抛（cwd 不存在等）时表里也要有一条 `failed`，
        // 否则"我起过它"这个事实凭空消失（用户会以为命令没发出去）。
        this.procs.set(id, info);

        let child: ChildProcess;
        try {
            const fd = openSync(logPath, "a");
            try {
                child = spawn("/bin/bash", ["-c", input.command], {
                    cwd: input.cwd,
                    detached: true,
                    stdio: ["ignore", fd, fd],
                });
            } finally {
                closeSync(fd);
            }
        } catch (e) {
            this.settle(id, null, null, e instanceof Error ? e.message : String(e));
            return this.procs.get(id) ?? info;
        }
        info.pid = child.pid ?? -1;
        this.children.set(id, child);
        // 不 unref：我们要 `close` 事件来判终态；main 退出后子进程仍在（detached）
        child.on("error", (e) => this.settle(id, null, null, e.message));
        child.on("close", (code, signal) => this.settle(id, code, signal ?? null));
        return info;
    }

    /** 全部进程，**活着的在前**、同状态按启动时间倒序（最近起的先看）。 */
    list(): ProcInfo[] {
        return [...this.procs.values()].sort((a, b) => {
            const ar = a.state === "running" ? 0 : 1;
            const br = b.state === "running" ? 0 : 1;
            if (ar !== br) return ar - br;
            return b.startedAt - a.startedAt;
        });
    }

    get(id: string): ProcInfo | undefined {
        return this.procs.get(id);
    }

    /** 读输出尾部；未登记 ⇒ `undefined`（调用方自己决定怎么说）。 */
    tail(id: string, lines = 40): TailResult | undefined {
        const info = this.procs.get(id);
        if (!info) return undefined;
        return tailOf(this.readLogTail(info.logPath), lines);
    }

    /**
     * 停止：先按**进程组**发 SIGTERM，`KILL_GRACE_MS` 后还在就 SIGKILL。
     *
     * 按组发是硬要求：`bash -c "a | b"` 的真正工作进程是 bash 的子孙，只杀 `child.pid`
     * 会留下跑满的孤儿（`##375` 同一个坑）。
     */
    kill(id: string): boolean {
        const info = this.procs.get(id);
        const child = this.children.get(id);
        if (!info || info.state !== "running" || !child?.pid) return false;
        this.killedByUs.add(id);
        this.signalGroup(child.pid, "SIGTERM");
        const timer = setTimeout(() => {
            if (this.procs.get(id)?.state === "running") this.signalGroup(child.pid!, "SIGKILL");
        }, KILL_GRACE_MS);
        timer.unref?.();
        return true;
    }

    /** 等它结束；`timeoutMs = 0` 表示一直等（调用方自己负责别等死）。 */
    wait(id: string, timeoutMs: number): Promise<ProcInfo | undefined> {
        const info = this.procs.get(id);
        if (!info) return Promise.resolve(undefined);
        if (info.state !== "running") return Promise.resolve(info);
        return new Promise((resolve) => {
            const list = this.waiters.get(id) ?? [];
            let done = false;
            const settle = (cur: ProcInfo | undefined): void => {
                if (done) return;
                done = true;
                this.waiters.set(
                    id,
                    (this.waiters.get(id) ?? []).filter((f) => f !== settle),
                );
                resolve(cur);
            };
            list.push(settle);
            this.waiters.set(id, list);
            if (timeoutMs > 0) {
                const timer = setTimeout(() => settle(this.procs.get(id)), timeoutMs);
                timer.unref?.();
            }
        });
    }

    /** 测试 / 收工清理用：丢掉全部记忆（不杀进程）。 */
    clear(): void {
        this.procs.clear();
        this.children.clear();
        this.waiters.clear();
        this.killedByUs.clear();
    }

    private signalGroup(pid: number, sig: NodeJS.Signals): void {
        try {
            process.kill(-pid, sig);
        } catch {
            // 组已空（全收完）或 pid 已回收：无可杀
        }
    }

    private readLogTail(logPath: string): string {
        try {
            const size = statSync(logPath).size;
            const start = Math.max(0, size - MAX_TAIL_BYTES * 4);
            return readFileSync(logPath).subarray(start).toString("utf8");
        } catch {
            return "";
        }
    }

    /**
     * 终态唯一落点。判据只有一条：**是不是我们杀的**。
     *
     * 其余一律 `exited` —— 退出码非零也还是 exited：命令跑了、结束了；"成功与否"由
     * `exitCode` 表达，不塞进状态里，否则模型得猜两个字段谁说话。
     */
    private settle(id: string, exitCode: number | null, signal: string | null, errorText?: string): void {
        const info = this.procs.get(id);
        if (!info || info.state !== "running") return;
        const ours = this.killedByUs.delete(id);
        info.state = errorText && exitCode === null && signal === null ? "failed" : ours ? "killed" : "exited";
        info.exitCode = exitCode;
        info.signal = signal;
        info.endedAt = this.now();
        if (errorText) info.error = errorText;
        this.children.delete(id);
        for (const w of this.waiters.get(id) ?? []) w(info);
        this.waiters.delete(id);
        this.notify(info);
    }

    private notify(info: ProcInfo): void {
        if (info.notified) return;
        const taskUri = info.origin?.taskUri;
        if (!taskUri || !this.notifier) return;
        info.notified = true;
        try {
            this.notifier(taskUri, notifyText(info, tailOf(this.readLogTail(info.logPath), 20)));
        } catch (e) {
            // 观测不许把业务炸掉：通知失败只留痕
            console.warn("[proc] 结束通知投递失败", info.id, e);
        }
    }
}

/** 全局单例（一个 app 实例一张表）。 */
export const procRegistry = new ProcRegistry();
