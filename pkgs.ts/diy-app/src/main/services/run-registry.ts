// 🎯 后台**运行**表（活体）—— ##408 刀 8，刀 9 按用户订正改名
//
// 用户 2026-10-23 的口径：「**不要进程恢复、不要文件审计、不要历史数据**，先把核心业务
// 实现掉：让 llm 起一个后台进程，自己心里有数、随时能查是死是活，也能放心结束本轮、
// 等 job 完成时插话激活。」后又订正：「proc 改为 run，因为长时间 job 不一定是进程，
// 可能是我们的一个 **js 进程内任务**。」
//
// 于是这里**刻意最小**：
//   · 真源 = 内存里的 `Map`（app 退出即空；重启后不接管、不 reconcile、不写 jsonl）；
//   · 叫 run 不叫 proc：`pid` 因此是**可选**的（**预留**：将来 js 进程内任务没有 pid）。
//     现实约束要看清：目前唯一的登记入口（`spawn`）是**进程型**，
//     没有任何代码会造出"无 pid 的 run"；`kill` 对无 pid 直接返回 false。
//     这条抽象只是留了形状，别在文档里把它说成已实现的功能。
//   · 输出 = 自己的 fd 直写 `$DIY_HOME/log/job/runs/<YYYY-MM-DD>/<id>/out.log`
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
//
// **前台命令不进这张表**（用户 2026-10-24 定口径：「前台进程不进观察名单，不属于 job，
// 就是当前 llm 自己的事，不管、不列出、不记录。job 现阶段只管后台任务」）。
// 于是这里没有 `track()`：`bash` 工具不加 `background` 时**零登记、零落盘**。
// 前台命令留下的孤儿进程仍归"进程总管"管（`owned-groups` 记组号），但那是进程视图，不是 job。
//
// **本文件内一律异步 IO**（用户 2026-10-24 定的硬规范：「app 不允许有 sync 的 io 操作」）：
// `node:fs/promises`，不出现 `readFileSync` / `writeFileSync` / `mkdirSync` / `execFileSync`。
// 判据不是"会不会卡"，而是同步 IO 会把整个主进程（含渲染、RPC）按在磁盘上，
// 一旦落在热路径上（面板每 3s 刷、每个输出块）就是 UI 掉帧的唯一原因。

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRuntimeConfig } from "../../runtime";
import { jobDoneNotify, MAX_TAIL_BYTES, tailOf, type RunLike, type TailResult } from "../../shared/run-status";
import type { NotifyItem } from "@diy-agent/context/envelope";
import { os } from "../os";
import { noShellHint } from "../os/shell-hint";
import { buildInvocation, preferredShell, shellSpecs } from "../os/shell";
import { localISOString } from "@diy-agent/time";

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
    /** 曾经有过后台子孙（根退了、组里还有活口）。收口后 `awaitingGroup` 会清掉，
     *  但"这条命令确实留下过后台活"这个事实要留住 —— 它决定要不要叫醒 agent（见 `settle`）。 */
    hadSurvivingGroup?: boolean;
    /** 根进程退出的时刻（`awaitingGroup` 时为真；用来交代「父命令 35ms 就退了，活的其实是它起的后台进程」） */
    rootExitedAt?: number;
}

export interface SpawnRunInput {
    command: string;
    cwd: string;
    /** 人话标题（缺省 = 命令首行） */
    title?: string;
    origin?: RunOrigin;
    /**
     * 到点整组 SIGTERM（后台模式的**显式** timeout 才有值）。
     *
     * 只有模型明确写了 `timeout` 才传：后台命令的缺省值是「不设超时」，否则一条
     * `background:true` 的 daemon 会在 300s 被静默做掉（见 `shared/tool-args.ts`）。
     */
    deadlineMs?: number;
}

/**
 * 「接管一条已经在跑的进程」的入参（##408 刀 19：前台转后台）。
 *
 * 与 `SpawnRunInput` 的差别只有一处：进程**已经存在**，我们不再 spawn，
 * 而是把它的输出接过来、把它的 `close` 接过来。
 */
/**
 * 「接管一条已经在跑的进程」—— **只要这三样**，不要求调用方懂 fs。
 *
 * 结构化类型（不 import `BashControl`）：`runBash` 的控制句柄天然满足它，
 * 而本文件不必反向依赖 `local-agent`（那会成环）。
 */
export interface AdoptableProcess {
    /** 已经在跑的子进程：`detached`，pgid == pid */
    readonly child: ChildProcess;
    readonly pid: number;
    /** 它**真正**的启动时刻（不是转的那一刻，否则面板时长会把前半段抹掉） */
    readonly startedAt: number;
    /** 交出后续输出，返回**转之前已经收到**的字节；调用即冻结原宿主（不再攒、不落 settle） */
    handoff(write: (b: Buffer) => void): Buffer;
}

export interface AdoptRunInput {
    process: AdoptableProcess;
    command: string;
    cwd: string;
    origin?: RunOrigin;
    title?: string;
}

export interface RunRegistryOptions {
    /** 运行产物根目录（缺省 `$DIY_HOME/log/job/run`）；测试注入 tmpdir */
    rootDir?: string;
    /** 时钟（测试注入假钟） */
    now?: () => number;
    /** 结束通知出口（缺省不通知）；真实 app 由 local-agent 注册「插话」实现 */
    notifier?: (taskUri: string, text: string, notify?: NotifyItem) => void;
    /** 进程组里还有没有活口（测试注入假判据；缺省 `kill(-pgid, 0)`） */
    probeGroup?: (pgid: number) => boolean;
    /** 组探活间隔（ms）；只在「根已退出、组里还有活口」期间跑，组空即停 */
    reapMs?: number;
    /** 内存表上限（缺省 `MAX_RUNS`；测试注入小值，避免真起数百个进程） */
    maxRuns?: number;
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
 * POSIX：`kill(-pgid, 0)` 只发信号 0（存在性检查），**不起进程**（比每次都 `ps` 便宜一个数量级）。
 * Windows：没有进程组语义，退化成判**根进程**存活（`os.jobAlive`；边界见那里）。
 * `EPERM` 也算活着：组里确实有进程，只是不归我们发信号。
 */
export function groupAlive(pgid: number): boolean {
    if (!Number.isInteger(pgid) || pgid <= 0) return false;
    return os.jobAlive(pgid);
}

/**
 * 等 spawn 定局：成功发 `spawn`，失败发 `error`（异步）。两者都没来就永远悬着 ——
 * 所以这里不设超时，只等 Node 自己那一个事件（它必来其一）。
 */
function awaitOpened(child: ChildProcess): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
        const done = (r: { ok: boolean; error?: string }): void => {
            child.off("spawn", onSpawn);
            child.off("error", onError);
            resolve(r);
        };
        const onSpawn = (): void => done({ ok: true });
        const onError = (e: Error): void => done({ ok: false, error: e.message });
        child.once("spawn", onSpawn);
        child.once("error", onError);
    });
}

/** 杀不及时的宽限期：先 SIGTERM（让它自己收尾），到这个点还在就 SIGKILL 整组。 */
export const KILL_GRACE_MS = 2_000;

/**
 * 内存表上限（**运行中的永不淘汰**）。
 *
 * 表里只剩**后台 run**（前台命令不登记，用户 2026-10-24 口径），数量本来就少；
 * 但一个长驻 app 仍会累积（每条 `background:true` 一条，且面板刷新时全表序列化过 IPC），
 * 所以照样设上限 —— 只淘汰已结束的，运行中的永不淘汰。
 */
export const MAX_RUNS = 300;

/**
 * 日期目录保留天数（`log/job/runs/<date>/`）。
 *
 * 这是**运行产物**的垃圾回收，不是审计账的保留策略（后者属 ##410）：一条 run 靠
 * meta.json + out.log 才「自己说得清」，但没人会回看一周前的 `ls` 输出。
 * 只按目录名（日期）整目录删，不碰今天的。
 */
export const KEEP_DAYS = 7;

/**
 * 运行产物根：`$DIY_HOME/log/job/runs`。
 *
 * 位置口径（用户 2026-10-24）：「这放到日志 log 目录下，`log/job/runs/` 下，
 * 即 `log/<module>/<用途|实体数据集合>`」。它同时宣告了本表的身份 ——
 * **运行产物**（日志），不是执行账；账本该在数据目录，而这里可整目录删。
 */
export function runRoot(home: string = readRuntimeConfig().home): string {
    return join(home, "log", "job", "runs");
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
    private readonly maxRuns: number;
    private readonly reapMs: number;
    private reapTimer?: ReturnType<typeof setTimeout>;
    /** 后台显式 timeout 的定时器（到点整组 SIGTERM；收口即清） */
    private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * 接管来的 run 的日志写句柄（只有 `adopt` 会产生；`spawn` 用 fd 直写，不需要）。
     *
     * 为什么用 `open` + 串行写链而不是 `createWriteStream`：收口时**通知**要读日志尾巴
     * （`notify` → `readLogTail`），而 stream 的 `end()` 是异步 flush —— 不等它就发通知，
     * 模型会看到「输出 399B」却 tail 到空。串行链让「收口 → flush → 通知」有确定的先后。
     */
    private readonly sinks = new Map<string, { chain: Promise<void>; close: () => Promise<void> }>();
    /** 收口时还没写完的那条链（`notify` 先等它，再 tail） */
    private readonly pendingFlush = new Map<string, Promise<void>>();
    /**
     * 日志**不可用**的 run（落盘阶段就失败了：进程在跑，但看不到输出）。
     *
     * 为什么要单独记一位：失败之后队列不再攒字节（见 `adopt`），所以「有没有日志」不能再靠
     * `logPath` 存不存在去猜 —— 那条路径我们知道，只是文件写不出来。
     */
    private readonly logFailed = new Set<string>();
    private notifier?: (taskUri: string, text: string, notify?: NotifyItem) => void;

    constructor(opts: RunRegistryOptions = {}) {
        this.rootDir = opts.rootDir ?? runRoot();
        this.now = opts.now ?? Date.now;
        this.probeGroup = opts.probeGroup ?? groupAlive;
        this.maxRuns = opts.maxRuns ?? MAX_RUNS;
        this.reapMs = opts.reapMs ?? 1000;
        this.notifier = opts.notifier;
        // 垃圾回收不挡启动：自有 Promise，失败静默（见 `pruneOldDirs`）
        void this.pruneOldDirs();
    }

    setNotifier(fn: ((taskUri: string, text: string, notify?: NotifyItem) => void) | undefined): void {
        this.notifier = fn;
    }

    /**
     * 起一条后台**运行**并**当场**登记。
     *
     * 登记时刻 = `spawn` 返回那一刻 —— 这是本刀的要害：v1 的「惰性晋升」（跑够 10s 才承认）
     * 让"进程活着但表里没有"成为常态（用户实测抓到 85 分钟无痕）。现在只要起了就在表里。
     */
    async spawn(input: SpawnRunInput): Promise<RunInfo> {
        const now = this.now();
        const id = newRunId(now);
        const dir = join(this.rootDir, dateDirOf(now), id);
        await mkdir(dir, { recursive: true });
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
        await this.writeMeta(info);

        // shell 解析由 OS 策略给（见 main/os/），同步且缓存。
        // 放在 spawn 之前是硬要求：spawn 之后任何 await 都会让 `spawn` / `error` 事件抢先发。
        const shells = shellSpecs();
        const shell = preferredShell();
        if (shell.missing) {
            this.settle(id, { exitCode: null, signal: null, errorText: noShellHint(shells) });
            return this.runs.get(id) ?? info;
        }

        let child: ChildProcess;
        // ⚠️ 挂监听的时机是有讲究的（改异步 IO 时踩过一次，别再犯）：
        //   `spawn` / `error` 是**下一个 tick** 才发的一次性事件。只要 `spawn()` 之后夹了
        //   **任何 await**（哪怕只是 `await fh.close()`），事件就先发了、监听器还没挂上 ⇒
        //   `awaitOpened()` 永远等不到 ⇒ `spawn()` 永久挂死（实测：一个只有 `sleep 5` 的用例
        //   卡满 60s 超时）。所以**紧贴 spawn 同步挂监听**，别的 await 一律排在后面。
        let opened: Promise<{ ok: boolean; error?: string }>;
        try {
            if (os.caps.shellRedirectsLog) {
                // Windows 上不能把父进程的 fd 直接当子进程 stdio：Git Bash（MSYS 运行时）拿到
                // Node 传进来的文件句柄后**静默丢弃输出**（实测：`bash --version` 退出码 0、
                // 日志为空）。改为让 bash 自己重定向（`exec >> log 2>&1`），stdio 全 ignore ——
                // 既绕开句柄问题，也仍然是「直落文件、不走管道」，`close` 语义不变。
                const fh = await open(logPath, "a");
                await fh.close();
                const inv = buildInvocation(shell, input.command, logPath);
                child = spawn(inv.file, inv.args, {
                    cwd: input.cwd,
                    // Windows 的 CREATE_NEW_PROCESS_GROUP 会让 PowerShell 丢管道/重定向；杀树走
                    // taskkill /T，不依赖进程组 ⇒ 按能力位决定（POSIX 仍需 detached 来按组收孤儿）。
                    detached: os.caps.processGroups,
                    stdio: ["ignore", "ignore", "ignore"],
                    windowsHide: true,
                });
                opened = awaitOpened(child);
            } else {
                // stdio 必须传 fd，所以这里得先 `await open`（异步打开，不阻塞主进程）
                const fh = await open(logPath, "a");
                try {
                    const inv = buildInvocation(shell, input.command);
                    child = spawn(inv.file, inv.args, {
                        cwd: input.cwd,
                        detached: true,
                        stdio: ["ignore", fh.fd, fh.fd],
                        windowsHide: true,
                    });
                    opened = awaitOpened(child);
                } finally {
                    // 子进程已 dup 走自己的那份，父进程这条句柄立刻还回去
                    await fh.close();
                }
            }
        } catch (e) {
            this.settle(id, { exitCode: null, signal: null, errorText: e instanceof Error ? e.message : String(e) });
            return this.runs.get(id) ?? info;
        }
        info.pid = child.pid;
        this.children.set(id, child);
        // ⚠️ 挂监听的次序是有讲究的（异步 IO 改写时踩过一次，别再犯）：
        //   `spawn` / `error` 都是**下一个事件循环**才发的一次性事件。之前这里先 `await writeMeta`
        //   （落盘），让出事件循环后事件先发了、监听器后挂 ⇒ `awaitOpened` 永远等不到，
        //   `spawn()` 就此挂死（实测：一个只有 `sleep 5` 的用例卡满 60s 超时）。
        //   所以：**spawn 一返回就同步挂上监听，然后才做任何 await**。
        const res = await opened!;
        if (!res.ok) {
            this.settle(id, { exitCode: null, signal: null, errorText: res.error ?? "启动失败" });
            await this.writeMeta(info);
            return this.runs.get(id) ?? info;
        }
        // 不 unref：我们要 `close` 事件来判终态；main 退出后子进程仍在（detached）
        child.on("error", (e) => this.onRootExit(id, { exitCode: null, signal: null, errorText: e.message }));
        child.on("close", (code, signal) => this.onRootExit(id, { exitCode: code, signal: signal ?? null }));
        // pid 是这条 run 的**身份**（进程组号也等于它）：spawn 定局后立刻补写 meta，
        // 否则盘上只有 command/cwd，重启后对不上任何东西。
        await this.writeMeta(info);
        if (input.deadlineMs !== undefined && input.deadlineMs > 0) this.armDeadline(id, input.deadlineMs);
        this.evictOld();
        return this.runs.get(id) ?? info;
    }

    /**
     * 后台的**显式** timeout：到点整组 SIGTERM（不走 `probeGroup`，也不叫醒 agent）。
     *
     * 用 `killedByUs` 标记 ⇒ 终态 `killed`：它是被策略停的，不是命令自己失败；
     * 模型能从 `timeout` 参数据此对上号（与前台超时同一口径）。
     */
    private armDeadline(id: string, ms: number): void {
        const timer = setTimeout(() => {
            this.deadlines.delete(id);
            const info = this.runs.get(id);
            if (!info || info.state !== "running" || info.pid === undefined) return;
            this.killedByUs.add(id);
            if (!os.caps.gracefulSignals) {
                // 无 SIGTERM 语义（Windows）：直接强杀，别排一个必然打空的宽限定时器
                this.signalGroup(info.pid, "SIGKILL");
                return;
            }
            this.signalGroup(info.pid, "SIGTERM");
            const grace = setTimeout(() => {
                if (this.runs.get(id)?.state === "running") this.signalGroup(info.pid as number, "SIGKILL");
            }, KILL_GRACE_MS);
            grace.unref?.();
        }, ms);
        timer.unref?.();
        this.deadlines.set(id, timer);
    }

    /** 淘汰最老的**已结束** run（运行中的永不淘汰）；只清内存，不动盘上产物。 */
    private evictOld(): void {
        if (this.runs.size <= this.maxRuns) return;
        const ended = [...this.runs.values()]
            .filter((r) => r.state !== "running")
            .sort((a, b) => a.startedAt - b.startedAt);
        for (const r of ended) {
            if (this.runs.size <= this.maxRuns) break;
            this.runs.delete(r.id);
        }
    }

    /**
     * 清掉过期日期目录（保留 `KEEP_DAYS` 天，今天永不动）。
     *
     * 一次启动做一次，不建定时器：这是垃圾回收，不是调度。删失败一律静默 ——
     * 目录可能是别的实例的，也可能正被读。
     */
    async pruneOldDirs(keepDays = KEEP_DAYS): Promise<void> {
        let names: string[];
        try {
            names = await readdir(this.rootDir);
        } catch {
            return;
        }
        const cutoff = new Date(this.now() - keepDays * 86_400_000);
        const edge = dateDirOf(cutoff.getTime());
        for (const name of names) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
            if (name >= edge) continue;
            try {
                await rm(join(this.rootDir, name), { recursive: true, force: true });
            } catch {
                // 清不掉就算了：产物垃圾不该把启动拖垮
            }
        }
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
    async tail(id: string, lines = 40): Promise<TailResult | undefined> {
        const info = this.runs.get(id);
        if (!info) return undefined;
        return tailOf(await this.readLogTail(info.logPath), lines);
    }

    /** 输出文件当前字节数（表格里"输出"列；在跑时它一直在长）。读不到给 `undefined`。 */
    async outputBytes(id: string): Promise<number | undefined> {
        const info = this.runs.get(id);
        if (!info) return undefined;
        try {
            return (await stat(info.logPath)).size;
        } catch {
            return undefined;
        }
    }

    /** 落盘的 `meta.json` 原文（面板「存储数据」tab 要给人看"到底存了什么"）。 */
    async metaJson(id: string): Promise<string | undefined> {
        const info = this.runs.get(id);
        if (!info) return undefined;
        try {
            return await readFile(join(info.dir, "meta.json"), "utf8");
        } catch {
            return undefined;
        }
    }

    /**
     * 停止：有 SIGTERM 语义的平台先按**进程组**发 SIGTERM，`KILL_GRACE_MS` 后还在就 SIGKILL；
     * 没有的平台（Windows）直接一次强杀（`caps.gracefulSignals`，别白等宽限期）。
     *
     * 没有 pid 的 run（**预留**的进程内任务形状）返回 false —— 那种 run 得由它自己
     * 的 cancel 收手，而 cancel 目前还不存在（见文件头：别把它当已实现）。
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
        if (!os.caps.gracefulSignals) {
            this.signalGroup(pid, "SIGKILL");
            return true;
        }
        this.signalGroup(pid, "SIGTERM");
        const timer = setTimeout(() => {
            if (this.runs.get(id)?.state === "running") this.signalGroup(pid, "SIGKILL");
        }, KILL_GRACE_MS);
        timer.unref?.();
        return true;
    }

    /**
     * 退出即收：把还在跑的 run 连同它们的进程组一起收掉（`before-quit` 调）。
     *
     * 为什么必须有：`spawn` 是 `detached` 的（要 pgid 归我们管），app 一退子进程就
     * reparent 到 launchd —— **没有任何内核机制能带走它们**（`PDEATHSIG` 只有 Linux 有）。
     * 不在这里收，它们就继续跑、继续写日志、继续没人收尸：那就是用户说的「进程泄漏」。
     *
     * 做法：整组 SIGTERM → 等 `graceMs`（或全部收口，通常毫秒级）→ 剩下的整组 SIGKILL。
     * **超预算也要返回** —— 退出预算是硬约束，不能把用户卡在 Dock 里等我们。
     *
     * 不叫醒 agent：进程都要没了，没人会收到（且 `killedByUs` 生效 ⇒ 收口即 `killed`，
     * 与用户口径「杀不发通知」一致）。终态照常落表，宿主还活着时（测试）账仍是准的。
     *
     * **兜不住的边界**：崩溃 / `kill -9` 主进程时这段根本不会跑 —— 那是 OS 层的事，
     * 靠组名册（`owned-groups`，带开机判据）下次启动认领，不在这里解决。
     *
     * 「手工设置脱离管理」的扩展点：将来若要给某条 run 标记「退出时别杀」，在这里加一个
     * 逐条跳过判据即可（**现在没有这个字段**，别提前造抽象）。
     *
     * 返回本应收掉的 run 条数（`0` = 本来就没在跑）。
     */
    async shutdown(opts: { graceMs?: number } = {}): Promise<number> {
        const targets = [...this.runs.values()].filter((r) => r.state === "running");
        if (targets.length === 0) return 0;
        if (!os.caps.gracefulSignals) {
            // 无 SIGTERM 语义：一次强杀；taskkill 是异步的，给一个短的收口窗口即可
            for (const info of targets) {
                if (info.pid === undefined) continue;
                this.killedByUs.add(info.id);
                this.signalGroup(info.pid, "SIGKILL");
            }
            await this.awaitSettled(targets, 500);
            return targets.length;
        }
        const graceMs = opts.graceMs ?? KILL_GRACE_MS;
        for (const info of targets) {
            if (info.pid === undefined) continue;
            this.killedByUs.add(info.id);
            this.signalGroup(info.pid, "SIGTERM");
        }
        await this.awaitSettled(targets, graceMs);
        // 宽限期到点还在跑的：整组 SIGKILL（仍收不掉就放弃 —— 预算比"条条收到"重要）
        const left = targets.filter((r) => this.runs.get(r.id)?.state === "running");
        for (const info of left) if (info.pid !== undefined) this.signalGroup(info.pid, "SIGKILL");
        if (left.length > 0) await this.awaitSettled(left, 500);
        return targets.length;
    }

    /** 等这些 run 全部离开 `running`，或超时（不改状态：状态只由 `settle` 改）。 */
    private async awaitSettled(list: RunInfo[], ms: number): Promise<void> {
        const pending = list.filter((r) => this.runs.get(r.id)?.state === "running");
        if (pending.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.all(pending.map((r) => this.wait(r.id, 0))),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
                timer.unref?.();
            }),
        ]);
        if (timer) clearTimeout(timer);
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
    /** 这条 run 的日志是否**不可用**（诊断口径：落盘失败 ⇒ 进程在跑但看不到输出）。 */
    logUnavailable(id: string): boolean {
        return this.logFailed.has(id);
    }

    clear(): void {
        for (const s of this.sinks.values()) void s.close();
        this.sinks.clear();
        this.logFailed.clear();
        this.pendingFlush.clear();
        this.runs.clear();
        this.children.clear();
        this.waiters.clear();
        this.killedByUs.clear();
        this.pendingExits.clear();
        if (this.reapTimer) clearTimeout(this.reapTimer);
        this.reapTimer = undefined;
        for (const t of this.deadlines.values()) clearTimeout(t);
        this.deadlines.clear();
    }

    private signalGroup(pid: number, sig: NodeJS.Signals): void {
        // 平台差异（进程组 / taskkill）只在 os/ 里；这里只表达「收掉这棵由 pid 领头的树」
        os.killOwned([{ pid }], sig);
    }

    /** `meta.json`：一条 run 的自述（**写一次就不再改**，终态不进这个文件）。 */
    private async writeMeta(info: RunInfo): Promise<void> {
        const meta = {
            id: info.id,
            command: info.command,
            ...(info.title ? { title: info.title } : {}),
            cwd: info.cwd,
            startedAt: localISOString(new Date(info.startedAt)),
            ...(info.pid !== undefined ? { pid: info.pid } : {}),
            ...(info.origin ? { origin: info.origin } : {}),
        };
        try {
            await writeFile(join(info.dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8"); // non-atomic-ok: 每个 run 独占自己的新目录，写完即冻结，不存在并发覆盖
        } catch (e) {
            // 落盘失败不许炸业务：run 照跑，只是"存储数据"tab 会空
            console.warn("[run] meta.json 写入失败", info.id, e);
        }
    }

    /**
     * 读日志尾部（**定长偏移读**，不整文件读进内存）。
     *
     * out.log 没有上限（`yes` / 编译器输出能长到几个 G）：先 `stat` 再读全文
     * 会把整个文件读进主进程内存 —— 面板每 3s 调一次，等于每 3s 一次卡死 + OOM 风险。
     * 定长偏移读 + 异步（用户 2026-10-24：**app 里不许有同步 IO**）。
     */
    private async readLogTail(logPath: string): Promise<string> {
        let fh: Awaited<ReturnType<typeof open>> | undefined;
        try {
            fh = await open(logPath, "r");
            const size = (await fh.stat()).size;
            const want = Math.min(size, MAX_TAIL_BYTES * 4);
            if (want <= 0) return "";
            const start = size - want;
            const buf = Buffer.allocUnsafe(want);
            let got = 0;
            while (got < want) {
                const r = await fh.read(buf, got, want - got, start + got);
                if (r.bytesRead <= 0) break;
                got += r.bytesRead;
            }
            return buf.subarray(0, got).toString("utf8");
        } catch {
            return "";
        } finally {
            await fh?.close().catch(() => undefined);
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
            info.hadSurvivingGroup = true;
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
     * **接管一条已经在跑的进程**（##408 刀 19：前台命令运行中转后台）。
     *
     * 用户口径（2026-10-24）：「转 job 不能重启进程、不能丢已产生的输出」。于是这里是
     * **adopt 不是 spawn**：同一个 child、同一个 pipe（绝不 `destroy()` 读端 —— 子进程
     * 写满 64KB 就阻塞），只把字节的去向换了。
     *
     * **为什么要在这里调 `handoff`（而不是让调用方先调）**：`handoff` 是同步切换，
     * 而建目录 / 开文件是异步的。若调用方先 handoff 再 await adopt，这段缝隙里的字节
     * 落进调用方的临时缓冲、顺序还可能被 adopt 的写链打乱。所以顺序钉死：
     *   open → handoff（同步，此刻起的字节进 `queued`）→ 写前半段 → 放行队列。
     * 这样「前半段 → 缝隙期字节 → 后续字节」的先后与进程产出顺序完全一致。
     */
    async adopt(input: AdoptRunInput): Promise<RunInfo> {
        const proc = input.process;
        const now = this.now();
        const id = newRunId(now);
        // 目录按**起跑时刻**分，与 spawn 那条路径同一口径（文件头：「日期取启动时刻的本地日期」）。
        // 用 `now`（= 转的那一刻）会让跨午夜转的 run 落进第二天，与它自己的 `startedAt` 不符。
        const dir = join(this.rootDir, dateDirOf(proc.startedAt), id);
        const logPath = join(dir, "out.log");
        const info: RunInfo = {
            id,
            command: input.command,
            cwd: input.cwd,
            state: "running",
            // 用命令**真正起跑**的时刻，不是转的那一刻（否则面板时长把前半段抹掉）
            startedAt: proc.startedAt,
            dir,
            logPath,
            pid: proc.pid,
            ...(input.title ? { title: input.title } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
        };
        // ── ① 同步交接（可能抛：已结束 / 已转过后台）──
        // 放在最前面：抛了就没有"半只 run"，调用方能干净地回一句「它已经结束了」。
        // 此刻起的字节先进 `queued`，等日志文件就绪再按序放行（先 `buffered` 后 `queued`）。
        let ready = false;
        /**
         * 落盘失败后置真：字节**照样消费**（不消费的话子进程写满 64KB 就永久阻塞 —— 那比丢日志
         * 严重得多），但不再进队列。没有这一位，「转后台的长跑进程 + 一次磁盘错误」= 队列无界
         * 增长到 OOM（##408 review）。
         */
        let discarding = false;
        const queued: Buffer[] = [];
        let chain: Promise<void> = Promise.resolve();
        let fh: Awaited<ReturnType<typeof open>> | undefined;
        const write = (b: Buffer): void => {
            if (discarding) return;
            if (!ready || !fh) {
                queued.push(b);
                return;
            }
            // 串行写：字节顺序 = 进程产出顺序（并发 write 会互相穿插）
            chain = chain.then(() => fh!.write(b).then(() => undefined)).catch(() => undefined);
        };
        const buffered = proc.handoff(write); // ← 已结束会在这里抛，原样冒给调用方
        this.runs.set(id, info);
        // ── ② 挂监听（紧跟交接，中间不许夹 await：`close` 可能就在下一 tick）──
        const child = proc.child;
        this.children.set(id, child);
        child.on("error", (e) => this.onRootExit(id, { exitCode: null, signal: null, errorText: e.message }));
        child.on("close", (code, signal) => this.onRootExit(id, { exitCode: code, signal: signal ?? null }));
        // ── ③ 落盘（失败只留痕：run 照跑、照收口，只是没有日志可看）──
        try {
            await mkdir(dir, { recursive: true });
            fh = await open(logPath, "w");
            const sink = {
                get chain() {
                    return chain;
                },
                close: async () => {
                    await chain.catch(() => undefined);
                    await fh!.close().catch(() => undefined);
                },
            };
            this.sinks.set(id, sink);
            await fh.write(buffered);
            ready = true;
            for (const b of queued) write(b);
            queued.length = 0;
            await this.writeMeta(info);
        } catch (e) {
            console.warn("[run] adopt 落盘失败", id, e);
            discarding = true;
            queued.length = 0;
            this.logFailed.add(id);
        }
        this.evictOld();
        // 极端竞态兜底：交接与退出同毫秒（`handoff` 里查过一次，这里再兜一次）
        if (child.exitCode !== null || child.signalCode !== null)
            this.onRootExit(id, { exitCode: child.exitCode, signal: child.signalCode });
        return this.runs.get(id) ?? info;
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
        // 接管来的 run：把日志写完再算收口（否则通知里的 tail 会读到半截）
        const sink = this.sinks.get(id);
        if (sink) {
            this.sinks.delete(id);
            const flushed = sink.close();
            this.pendingFlush.set(id, flushed);
            void flushed.finally(() => this.pendingFlush.delete(id));
        }
        const dl = this.deadlines.get(id);
        if (dl) {
            clearTimeout(dl);
            this.deadlines.delete(id);
        }
        this.evictOld();
        for (const w of this.waiters.get(id) ?? []) w(info);
        this.waiters.delete(id);
        // 谁该被叫醒：在这张表里的**都是后台 run**（前台不登记，用户 2026-10-24 定的口径），
        // 工具早就返回了、结局只能靠通知知道 ⇒ 只要不是我们杀的（`ours`）就叫一次。
        // 幂等由 `notified` 保证：进程组的生命周期里可能有多次收口尝试，唤醒只发一次。
        if (!ours) void this.notify(info);
    }

    private async notify(info: RunInfo): Promise<void> {
        if (info.notified) return;
        const taskUri = info.origin?.taskUri;
        if (!taskUri || !this.notifier) return;
        // 接管来的 run 的日志是我们自己写的：先等写链落干净，tail 才不是半截
        const pending = this.pendingFlush.get(info.id);
        if (pending) await pending.catch(() => undefined);
        info.notified = true;
        try {
            const notify = jobDoneNotify(info, tailOf(await this.readLogTail(info.logPath), 20));
            this.notifier(taskUri, notify.text ?? "", notify);
        } catch (e) {
            // 观测不许把业务炸掉：通知失败只留痕
            console.warn("[run] 结束通知投递失败", info.id, e);
        }
    }
}

/** 全局单例（一个 app 实例一张表）。 */
export const runRegistry = new RunRegistry();
