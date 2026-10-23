// 🎯 后台**运行**表（活体）—— ##408 刀 8，刀 9 按用户订正改名
//
// 用户 2026-10-23 的口径：「**不要进程恢复、不要文件审计、不要历史数据**，先把核心业务
// 实现掉：让 llm 起一个后台进程，自己心里有数、随时能查是死是活，也能放心结束本轮、
// 等 job 完成时插话激活。」后又订正：「proc 改为 run，因为长时间 job 不一定是进程，
// 可能是我们的一个 **js 进程内任务**。」
//
// 于是这里**刻意最小**：
//   · 真源 = 内存里的 `Map`（app 退出即空；重启后不接管、不 reconcile、不写 jsonl）；
//   · 叫 run 不叫 proc：`pid` 因此是**可选**的 —— 进程型有 pid，进程内任务没有；
//     杀它也不走信号而走 `cancel`（进程内任务自己收手）；
//   · 输出 = 自己的 fd 直写 `$DIY_HOME/log/job/run/<YYYY-MM-DD>/<id>/out.log`
//     （运行的产物，不是账本；要看就 tail 它，不额外维护"日志管理"）；
//   · 落盘只有两样，都是为了「这条 run 自己说得清」：`meta.json`（谁起的、什么命令、
//     从哪个 cwd、什么时候起）+ `out.log`。**没有历史账、没有保留策略、没有重放**。
//   · 判活 = 我们持有 `ChildProcess` 的 `close` 事件（不需要 ps 轮询、不需要定时器）；
//   · 收口 = 状态落到终态后，若这条 run 是某个任务的工具调用起的，**投一条插话**唤醒它。
//
// 为什么不做定时器：判活靠事件，不靠 tick。整条链上唯一的 `setTimeout` 是 kill 的宽限期。
//
// 生命周期唯一的坑（写在这里，别再踩一遍）：
//   子进程 `detached: true` + `stdio: ["ignore", <fd>, <fd>]` —— **不给管道**。
//   给管道就必须等 EOF，而未 setsid 的子孙可能继续持有写端 ⇒ `close` 迟到（##418 同源）。
//   输出直落文件后，`close` 与"进程真的结束了"一一对应。
//
// 日期目录（用户要求「按 date 做数据分散」）取**启动时刻的本地日期**，不是收口日期：
// 一条跑过午夜的属"哪天起的"，否则同一条 run 的日志会随收口时间跳到别的目录。

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readRuntimeConfig } from "../../runtime";
import { MAX_TAIL_BYTES, notifyText, tailOf, type RunLike, type TailResult } from "../../shared/run-status";

/** run 的来源锚点：哪一轮、哪一步、哪个工具调用起的（`toolCallId` 是定位键）。 */
export interface RunOrigin {
    taskUri: string;
    turnId?: string;
    stepId?: string;
    toolCallId?: string;
}

export interface RunInfo extends RunLike {
    /** 进程型才有（进程内 JS 任务没有 pid）；`detached` 时它同时是进程组 id */
    pid?: number;
    cwd: string;
    /** 人话标题；缺省用命令首行（表格里不必自己截） */
    title?: string;
    /** run 的落盘目录（`meta.json` + `out.log` 都在里面） */
    dir: string;
    logPath: string;
    origin?: RunOrigin;
    /** 起不来时的原因（`failed` 专属） */
    error?: string;
    /** 结束通知是否已投递（防重复唤醒） */
    notified?: boolean;
    /**
     * 根进程（我们 spawn 的 bash）已退出、但**进程组里还有活口** ⇒ 这条 run 仍在跑。
     * 用户口径：「通知时机 = 真正没人跑了那一刻（进程组空）」。
     */
    awaitingGroup?: boolean;
    /** 根进程退出的时刻（`awaitingGroup` 时为真；用来交代「父命令 35ms 就退了，活的其实是它起的后台进程」） */
    rootExitedAt?: number;
    /**
     * 前台 run（`bash` 工具没给 `background`，工具调用正在等它的结果）：
     * 结果直接回给调用方，**结束不投插话**；面板上标出来，好区分"谁在等"。
     */
    foreground?: boolean;
}

/** 前台 run 收口时要交代的三件事（其余从 `runBash` 的结局映射）。 */
export interface FinishRunInput {
    exitCode?: number | null;
    signal?: string | null;
    /** 我们主动杀的（超时 / 取消）—— 与后台口径一致 */
    killed?: boolean;
    /** 起不来 / 异常的原因（无退出码无信号时判 `failed`） */
    error?: string;
}

/** 前台 run 的句柄：输出边跑边追加、结束后收口。 */
export interface RunHandle {
    readonly info: RunInfo;
    /** spawn 拿到 pid 后补录（同时补写 meta.json —— pid 是这条 run 的身份之一） */
    setPid(pid: number | undefined): void;
    /** 追加输出（直接写 out.log，不攒内存） */
    write(chunk: Buffer): void;
    /** 收口（幂等：重复调用只有第一次生效） */
    finish(o?: FinishRunInput): void;
}

export interface SpawnRunInput {
    command: string;
    cwd: string;
    /** 人话标题（缺省 = 命令首行） */
    title?: string;
    origin?: RunOrigin;
}

export interface RunRegistryOptions {
    /** 运行产物根目录（缺省 `$DIY_HOME/log/job/run`）；测试注入 tmpdir */
    rootDir?: string;
    /** 时钟（测试注入假钟） */
    now?: () => number;
    /** 结束通知出口（缺省不通知）；真实 app 由 local-agent 注册「插话」实现 */
    notifier?: (taskUri: string, text: string) => void;
    /** 进程组里还有没有活口（测试注入假判据；缺省 `kill(-pgid, 0)`） */
    probeGroup?: (pgid: number) => boolean;
    /** 组探活间隔（ms）；只在「根已退出、组里还有活口」期间跑，组空即停 */
    reapMs?: number;
}

/** 根进程的退出信息：组空之前先存着，收口时才用。 */
interface PendingExit {
    exitCode: number | null;
    signal: string | null;
    errorText?: string;
    killed?: boolean;
}

/**
 * 进程组里还有活口吗？
 *
 * 用 `kill(-pgid, 0)` 只发信号 0（存在性检查），**不起进程**（比每次都 `ps` 便宜一个数量级）。
 * `EPERM` 也算活着：组里确实有进程，只是不归我们发信号。
 */
export function groupAlive(pgid: number): boolean {
    if (!Number.isInteger(pgid) || pgid <= 0) return false;
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** 杀不及时的宽限期：先 SIGTERM（让它自己收尾），到这个点还在就 SIGKILL 整组。 */
export const KILL_GRACE_MS = 2_000;

/** 运行产物根：`$DIY_HOME/log/job/run`（**不是** `jobs/` —— 那批是 v1 的执行账）。 */
export function runRoot(home: string = readRuntimeConfig().home): string {
    return join(home, "log", "job", "run");
}

/** 本地日期目录名 `YYYY-MM-DD`（按启动时刻；理由见文件头）。 */
export function dateDirOf(ts: number): string {
    const d = new Date(ts);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function newRunId(now: number): string {
    return `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class RunRegistry {
    private readonly runs = new Map<string, RunInfo>();
    private readonly children = new Map<string, ChildProcess>();
    private readonly waiters = new Map<string, Array<(info: RunInfo) => void>>();
    /** 我们主动杀过的 id：决定终态是 `killed` 还是 `exited` */
    private readonly killedByUs = new Set<string>();
    /** 根进程已退出、等进程组空的那些 id 的退出信息（收口要用的都得先存着） */
    private readonly pendingExits = new Map<string, PendingExit>();
    private readonly rootDir: string;
    private readonly now: () => number;
    private readonly probeGroup: (pgid: number) => boolean;
    private readonly reapMs: number;
    private reapTimer?: ReturnType<typeof setTimeout>;
    private notifier?: (taskUri: string, text: string) => void;

    constructor(opts: RunRegistryOptions = {}) {
        this.rootDir = opts.rootDir ?? runRoot();
        this.now = opts.now ?? Date.now;
        this.probeGroup = opts.probeGroup ?? groupAlive;
        this.reapMs = opts.reapMs ?? 1000;
        this.notifier = opts.notifier;
    }

    setNotifier(fn: ((taskUri: string, text: string) => void) | undefined): void {
        this.notifier = fn;
    }

    /**
     * 起一条后台**运行**并**当场**登记。
     *
     * 登记时刻 = `spawn` 返回那一刻 —— 这是本刀的要害：v1 的「惰性晋升」（跑够 10s 才承认）
     * 让"进程活着但表里没有"成为常态（用户实测抓到 85 分钟无痕）。现在只要起了就在表里。
     */
    spawn(input: SpawnRunInput): RunInfo {
        const now = this.now();
        const id = newRunId(now);
        const dir = join(this.rootDir, dateDirOf(now), id);
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "out.log");
        const info: RunInfo = {
            id,
            command: input.command,
            cwd: input.cwd,
            state: "running",
            startedAt: now,
            dir,
            logPath,
            ...(input.title ? { title: input.title } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
        };
        // 先登记再 spawn：spawn 同步抛（cwd 不存在等）时表里也要有一条 `failed`，
        // 否则"我起过它"这个事实凭空消失（用户会以为命令没发出去）。
        this.runs.set(id, info);
        // meta.json 写在 spawn **之前**：起不来的那条也要留下「我起过什么」。
        this.writeMeta(info);

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
            this.settle(id, { exitCode: null, signal: null, errorText: e instanceof Error ? e.message : String(e) });
            return this.runs.get(id) ?? info;
        }
        info.pid = child.pid;
        this.children.set(id, child);
        // 不 unref：我们要 `close` 事件来判终态；main 退出后子进程仍在（detached）
        child.on("error", (e) => this.onRootExit(id, { exitCode: null, signal: null, errorText: e.message }));
        child.on("close", (code, signal) => this.onRootExit(id, { exitCode: code, signal: signal ?? null }));
        return info;
    }

    /**
     * 登记一条**前台** run（##408 刀 11：`bash` 工具不加 `background` 时也进表）。
     *
     * 为什么前台也要登记：用户实测「`nohup sleep 10 &` 跑了但表里什么都没有」——
     * 判据没错，是**表里没有它爹**。不加这一条，`&` 起的孤儿进程就永远只有
     * "未登记"那一行，进程一死连"哪条命令起的"都无从回答。
     *
     * 与 `spawn` 的分工：进程由调用方（`runBash`）拉起并持有，这里只负责**记账 + 落 out.log**
     * —— 于是前台的输出也被完整保存（且不再额外攒一份内存）。
     */
    track(input: SpawnRunInput): RunHandle {
        const now = this.now();
        const id = newRunId(now);
        const dir = join(this.rootDir, dateDirOf(now), id);
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "out.log");
        const info: RunInfo = {
            id,
            command: input.command,
            cwd: input.cwd,
            state: "running",
            startedAt: now,
            dir,
            logPath,
            foreground: true,
            ...(input.title ? { title: input.title } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
        };
        this.runs.set(id, info);
        this.writeMeta(info);
        let fd: number | undefined;
        try {
            fd = openSync(logPath, "a");
        } catch (e) {
            // 落盘失败不许炸业务：run 照跑，只是"输出"tab 会空
            console.warn("[run] out.log 打不开", id, e);
        }
        const closeFd = (): void => {
            if (fd === undefined) return;
            try {
                closeSync(fd);
            } catch {
                // 已关 / 已失效：无可关
            }
            fd = undefined;
        };
        let done = false;
        return {
            info,
            setPid: (pid) => {
                if (pid === undefined) return;
                info.pid = pid;
                this.writeMeta(info);
            },
            write: (chunk) => {
                if (done || fd === undefined || chunk.length === 0) return;
                try {
                    writeSync(fd, chunk);
                } catch (e) {
                    console.warn("[run] out.log 写入失败", id, e);
                    closeFd();
                }
            },
            finish: (o) => {
                if (done) return;
                done = true;
                closeFd();
                this.onRootExit(id, {
                    exitCode: o?.exitCode ?? null,
                    signal: o?.signal ?? null,
                    ...(o?.error ? { errorText: o.error } : {}),
                    ...(o?.killed ? { killed: true } : {}),
                });
            },
        };
    }

    /** 全部 run，**活着的在前**、同状态按启动时间倒序（最近起的先看）。 */
    list(): RunInfo[] {
        return [...this.runs.values()].sort((a, b) => {
            const ar = a.state === "running" ? 0 : 1;
            const br = b.state === "running" ? 0 : 1;
            if (ar !== br) return ar - br;
            return b.startedAt - a.startedAt;
        });
    }

    /** run 根进程 pid → runId（`ps` 扫描时把进程归到某条 run 名下；进程内任务没有 pid 故不在表里）。 */
    pidMap(): Map<number, string> {
        const out = new Map<number, string>();
        for (const r of this.runs.values()) if (r.pid !== undefined) out.set(r.pid, r.id);
        return out;
    }

    get(id: string): RunInfo | undefined {
        return this.runs.get(id);
    }

    /** 读输出尾部；未登记 ⇒ `undefined`（调用方自己决定怎么说）。 */
    tail(id: string, lines = 40): TailResult | undefined {
        const info = this.runs.get(id);
        if (!info) return undefined;
        return tailOf(this.readLogTail(info.logPath), lines);
    }

    /** 输出文件当前字节数（表格里"输出"列；在跑时它一直在长）。读不到给 `undefined`。 */
    outputBytes(id: string): number | undefined {
        const info = this.runs.get(id);
        if (!info) return undefined;
        try {
            return statSync(info.logPath).size;
        } catch {
            return undefined;
        }
    }

    /** 落盘的 `meta.json` 原文（面板「存储数据」tab 要给人看"到底存了什么"）。 */
    metaJson(id: string): string | undefined {
        const info = this.runs.get(id);
        if (!info) return undefined;
        try {
            return readFileSync(join(info.dir, "meta.json"), "utf8");
        } catch {
            return undefined;
        }
    }

    /**
     * 停止：进程型先按**进程组**发 SIGTERM，`KILL_GRACE_MS` 后还在就 SIGKILL；
     * 进程内任务（没有 pid）走它自己的 `cancel`。
     *
     * 按组发是硬要求：`bash -c "a | b"` 的真正工作进程是 bash 的子孙，只杀 `child.pid`
     * 会留下跑满的孤儿（`##375` 同一个坑）。
     */
    kill(id: string): boolean {
        const info = this.runs.get(id);
        if (!info || info.state !== "running") return false;
        // 用 info.pid 而不是 children：根进程可能早就退了，活的是它起的后台进程（组还在）
        const pid = info.pid;
        if (!pid) return false;
        this.killedByUs.add(id);
        this.signalGroup(pid, "SIGTERM");
        const timer = setTimeout(() => {
            if (this.runs.get(id)?.state === "running") this.signalGroup(pid, "SIGKILL");
        }, KILL_GRACE_MS);
        timer.unref?.();
        return true;
    }

    /** 等它结束；`timeoutMs = 0` 表示一直等（调用方自己负责别等死）。 */
    wait(id: string, timeoutMs: number): Promise<RunInfo | undefined> {
        const info = this.runs.get(id);
        if (!info) return Promise.resolve(undefined);
        if (info.state !== "running") return Promise.resolve(info);
        return new Promise((resolve) => {
            const list = this.waiters.get(id) ?? [];
            let done = false;
            const settle = (cur: RunInfo | undefined): void => {
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
                const timer = setTimeout(() => settle(this.runs.get(id)), timeoutMs);
                timer.unref?.();
            }
        });
    }

    /** 测试 / 收工清理用：丢掉全部记忆（不杀进程）。 */
    clear(): void {
        this.runs.clear();
        this.children.clear();
        this.waiters.clear();
        this.killedByUs.clear();
        this.pendingExits.clear();
        if (this.reapTimer) clearTimeout(this.reapTimer);
        this.reapTimer = undefined;
    }

    private signalGroup(pid: number, sig: NodeJS.Signals): void {
        try {
            process.kill(-pid, sig);
        } catch {
            // 组已空（全收完）或 pid 已回收：无可杀
        }
    }

    /** `meta.json`：一条 run 的自述（**写一次就不再改**，终态不进这个文件）。 */
    private writeMeta(info: RunInfo): void {
        const meta = {
            id: info.id,
            command: info.command,
            ...(info.title ? { title: info.title } : {}),
            cwd: info.cwd,
            startedAt: new Date(info.startedAt).toISOString(),
            ...(info.pid !== undefined ? { pid: info.pid } : {}),
            ...(info.origin ? { origin: info.origin } : {}),
        };
        try {
            writeFileSync(join(info.dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8"); // non-atomic-ok: 每个 run 独占自己的新目录，写完即冻结，不存在并发覆盖
        } catch (e) {
            // 落盘失败不许炸业务：run 照跑，只是"存储数据"tab 会空
            console.warn("[run] meta.json 写入失败", info.id, e);
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
     * **根进程退出**（我们 spawn 的那个 bash）—— 注意：它不等于这条 run 结束。
     *
     * 用户实测的病：`nohup sleep 600 > /dev/null 2>&1 &` 这条命令 35ms 就返回，
     * 而真正在跑的是它起的 `sleep 600`（已被 reparent 到 launchd）。按"根退出 = 结束"
     * 算，表上写「已结束 · 35ms」、通知也在 35ms 就发完，长活永远不长。
     *
     * 判据因此成一句：**进程组里还有活口 ⇒ 这条 run 还在跑**（用户口径：
     * 「通知时机 = 真正没人跑了那一刻（进程组空）」，只发一次）。
     */
    private onRootExit(id: string, exit: PendingExit): void {
        const info = this.runs.get(id);
        if (!info || info.state !== "running") return;
        this.pendingExits.set(id, exit);
        const pgid = info.pid;
        if (pgid !== undefined && this.probeGroup(pgid)) {
            info.awaitingGroup = true;
            info.rootExitedAt = this.now();
            // 根的 ChildProcess 已经结束（close 已到），内存里不必再留着；组探活只需要 pgid
            this.children.delete(id);
            this.scheduleReap();
            return;
        }
        this.settle(id, exit);
    }

    /**
     * 组探活：**只在「根已退出、组里还有活口」期间**跑，组空即停（自己清掉定时器）。
     *
     * 为什么这里必须有定时器：`wait` 只能等**自己的孩子**，被 reparent 到 launchd 的
     * 后台进程没有内核事件可挂；`kill(-pgid, 0)` 是同步且极便宜的存在性检查（不起进程）。
     * 所以这是"有人还在跑"的有界轮询，不是调度器的 tick —— 全表都没有活口时它不存在。
     */
    private hasAwaitingGroup(): boolean {
        for (const r of this.runs.values()) if (r.state === "running" && r.awaitingGroup) return true;
        return false;
    }

    private scheduleReap(): void {
        if (this.reapTimer) return;
        const timer = setTimeout(() => {
            this.reapTimer = undefined;
            for (const info of this.runs.values()) {
                if (info.state !== "running" || !info.awaitingGroup) continue;
                if (info.pid !== undefined && this.probeGroup(info.pid)) continue;
                const exit = this.pendingExits.get(info.id) ?? { exitCode: null, signal: null };
                this.settle(info.id, exit);
            }
            if (this.hasAwaitingGroup()) {
                this.scheduleReap();
            }
        }, this.reapMs);
        timer.unref?.();
        this.reapTimer = timer;
    }

    /**
     * 终态唯一落点。判据只有一条：**是不是我们杀的**。
     *
     * 其余一律 `exited` —— 退出码非零也还是 exited：命令跑了、结束了；"成功与否"由
     * `exitCode` 表达，不塞进状态里，否则模型得猜两个字段谁说话。
     *
     * 通知（唤醒 agent）**只在这里发一次**，且**我们主动杀的不发**：用户口径
     * 「通知是背景 job 执行完、唤醒 agent 给任务发消息，不是 kill」—— 杀完立刻把人叫醒
     * 等于自问自答，结果（`killed` + 信号）留在表里等人/下一轮自己看。
     */
    private settle(id: string, exit: PendingExit): void {
        const info = this.runs.get(id);
        if (!info || info.state !== "running") return;
        const ours = !!exit.killed || this.killedByUs.delete(id);
        info.state = exit.errorText && exit.exitCode === null && !exit.signal ? "failed" : ours ? "killed" : "exited";
        info.exitCode = exit.exitCode;
        info.signal = exit.signal;
        info.endedAt = this.now();
        info.awaitingGroup = false;
        if (exit.errorText) info.error = exit.errorText;
        this.pendingExits.delete(id);
        this.children.delete(id);
        for (const w of this.waiters.get(id) ?? []) w(info);
        this.waiters.delete(id);
        if (!ours) this.notify(info);
    }

    private notify(info: RunInfo): void {
        if (info.notified) return;
        const taskUri = info.origin?.taskUri;
        if (!taskUri || !this.notifier) return;
        info.notified = true;
        try {
            this.notifier(taskUri, notifyText(info, tailOf(this.readLogTail(info.logPath), 20)));
        } catch (e) {
            // 观测不许把业务炸掉：通知失败只留痕
            console.warn("[run] 结束通知投递失败", info.id, e);
        }
    }
}

/** 全局单例（一个 app 实例一张表）。 */
export const runRegistry = new RunRegistry();
