// @diy-agent/tools/src/shell/run.ts — shell 命令的**执行器**（自持 spawn，宿主无关）
//
// 从 apps/diy-app/src/main/services/local-agent.ts 逐字搬来（##515 第 1 步）。
// 行为语义**一个都没改**，只把两处宿主耦合换成依赖注入：
//   · 进程组归属记账（`ownedGroups.record`）→ `hooks.onSpawn(pid)`（宿主自己记）；
//   · 「杀整组」与「detached 能力位」（`os.caps.processGroups` / `os.killOwned`）→ `ShellRuntime`。
// 其余（结算判据 / 退出宽限 / 转后台句柄 / 结果头）逐字保留 —— 见各段头注。
//
// 宿主不传 `runtime` 时用包内兜底（POSIX 杀进程组 / Windows 只杀直接子进程）：
// diy-app 传自己的 `os` 策略（`killOwned` 能整树 `taskkill /T`），bot 用兜底即可。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { buildInvocation, FALLBACK_SHELL, noShellHint, type ShellSpec } from "./spec.js";
import { BASH_MAX_BUFFER_BYTES, fmtBytes, renderBashHead, type BashRun } from "./result.js";

/** 执行器只认这一个预算字段（宿主的完整 limits 结构不进来） */
export interface ShellLimits {
    /** 缺省超时（毫秒）；0 = 不设超时 */
    readonly bashTimeoutMs: number;
}

/**
 * 平台能力注入（宿主决定）：这两项是**系统事实**，不该散进执行器。
 *
 * - `processGroups`：能否让子进程自持进程组（POSIX `detached: true` = setsid）。
 *   Windows 的 detached 会让 PowerShell 5.1 丢 stdout 管道 ⇒ 那边必须是 false（宿主按 caps 给）。
 * - `killGroup`：杀**整组 / 整棵树**。POSIX = `kill(-pid)`；Windows = `taskkill /T /F`。
 */
export interface ShellRuntime {
    readonly processGroups: boolean;
    killGroup(child: ChildProcess): void;
}

/** 包内兜底：POSIX 杀进程组，Windows 只能杀直接子进程（宿主应传更完整的实现）。 */
export const defaultShellRuntime: ShellRuntime = (() => {
    const processGroups = process.platform !== "win32";
    return {
        processGroups,
        killGroup(child: ChildProcess): void {
            if (child.pid == null) return;
            // ⚠️ 已收尸就不再动它：pid 是**可复用**的，此时 `-pid` 可能指向一个毫不相干的进程组
            //    （取消信号比命令活得久是常态 —— 用户可能在这条命令早就跑完之后才点停止）。
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                // POSIX：组 id = 子进程 pid（detached 起的）；Windows：没有组概念，降级成直接子进程
                process.kill(processGroups ? -child.pid : child.pid, "SIGKILL");
            } catch {
                // ESRCH（组已空）/ EPERM 都无害 —— 想杀的都已经不在了
            }
        },
    };
})();

/**
 * runBash 的**外部观察口**（##408 刀 5）：只被动接收事实，不影响判据。
 *
 * 为什么不做成 return 值的一部分：job 记账是**观测**，命令的成败判据（##332/##353）
 * 不能因为「记账写没写成」而变化 —— 两条线在 `runBash` 里只有一个接触点就是这里。
 */
export interface BashRunHooks {
    /** 子进程起来了（采样 / 诊断要 pid） */
    onSpawn?(pid: number): void;
    /** 收到一块输出（stdout / stderr 都算，按到达顺序；已按 buffer 上限裁过） */
    onChunk?(chunk: Buffer): void;
    /**
     * 交出「把这次前台执行转成后台」的句柄（##408 刀 19）。
     *
     * 只在前台路径给：`runBash` 的 Promise 一旦 resolve，句柄即作废（`ended()` 为真）。
     * 转后台**不重启进程、不换读端**（见 `handoff` 注释）。
     */
    onControl?(ctl: BashControl): void;
}

/**
 * 转后台被拒（**不是缺陷**：连按两次、或命令恰好在这毫秒结束 —— 都是正常的用户时序）。
 *
 * 单独一个类只为带 `code`（`rule.err-triage`）并让调用方能按码分支：`already-detached`
 * 说明"已经在后台表里了，去看那儿"，`already-ended` 说明"它已经结束，结果在工具块里"。
 */
export class DetachError extends Error {
    readonly code: string;
    constructor(input: { code: string; message: string }) {
        super(input.message);
        this.code = input.code;
    }
}

/**
 * 前台命令的「转后台」句柄。
 *
 * 语义就一句：**把这次调用的等待者和输出去处换掉，进程本身不动**。
 * 为什么不能重开一条后台 run 再杀前台：那是"重启命令"，已跑的时间和前半段输出全丢。
 */
export interface BashControl {
    /** 子进程本体（`adopt` 要挂 `close` 监听 —— 判活靠事件，不靠轮询） */
    readonly child: ChildProcess;
    readonly pid: number;
    /** 命令真正起跑的时刻（`adopt` 用它当 `startedAt`，否则面板时长会从 0 算） */
    readonly startedAt: number;
    /** 已经结束了？（转后台前必须查：结束的进程没有"转"这回事） */
    ended(): boolean;
    /**
     * 交接后续输出，返回**转之前已经收到**的字节。
     *
     * 调用即生效：本函数（`runBash`）从此不再攒缓冲、不再判 `maxBuffer`、不再落 settle，
     * 超时定时器与 abort 监听一并撤掉 —— 这三条是转后台必踩的坑，全部收在这一个点。
     * 失败（已结束 / 没有 pid）时抛错，调用方据此如实告诉模型「它已经结束了」。
     */
    handoff(write: (b: Buffer) => void): Buffer;
    /**
     * 交接之后，**替这次工具调用收尾**（把结果文本回给工具）。
     *
     * 为什么由调用方来填这一句：转后台后的 run id 是 `RunRegistry.adopt()` 分配的，
     * `runBash` 不认识 run 表 —— 硬把 runId 塞进 `handoff` 会让这一层多背一个它不该知道的 id。
     * 代价是**必须调**：不调则该工具调用永远挂着（本轮也就退不出去）。
     * 未 `handoff` 就调 = 编程错误（抛 `agent/job-not-detached`）。
     */
    finishAsDetached(text: string): void;
}

/**
 * 子进程的错误形状（##332 ③ 的判据落点）。
 *
 * 只用一个类型服务两条到达路径（callback / 同步抛），判据也只有一处读它：
 * **`code` 是数字** ⇒ 命令跑起来了（退出码）· **字符串** ⇒ spawn 层失败（ENOENT/EACCES/ENOTDIR…）。
 */
type BashExecError = { name?: string; code?: string | number | null; killed?: boolean; message?: string } | null;

/** 超时时长的人读文案：整秒不带小数、否则保留一位（400ms → 0.4s） */
function fmtTimeout(ms: number): string {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

/**
 * bash：300s（5 分钟）超时；**命令跑起来了**的失败以文本回喂模型（错误是一等信息，不抛），
 * **命令没跑起来**的（spawn / IO 失败）则抛。
 *
 * ── ##353 复议（##332 ① 档）：「非零退出」不再一律当数据 ──
 *   ① **命令级非零退出**（`err.code` 是数字 ⇒ 命令确实跑起来了）：
 *        · **有错误输出**（stderr 非空）⇒ **失败**（`failed: true`：命令报了错，✗ 且恒展开）；
 *        · **无错误输出** ⇒ **数据**（`grep`/`fd`/`rg`/`test` 未命中 = 退出 1 且静默 —— 这不是
 *          "失败"，是"没查到"；模型仍靠 `[退出码 N]` 改命令 ⇒ 保持 ✓）。
 *        · 正文一律 `[退出码 N]` + 输出，**不再兜底塞 `err.message`**：`Command failed: /bin/bash -c …`
 *          正是「✓ + Command failed」自相矛盾的来源（无输出时把 Node 的报错文案当成了命令输出）。
 *   ② **超时 / 取消**（`err.killed` / AbortError）⇒ 当数据（**保持现状**，见 ##332 ②）——
 *      **取消另有"真杀"这一半（##375）**：AbortError 只保证**直接子进程**（`/bin/bash`）被 kill，
 *      命令真正干活的那一层（`bash -c "sleep 1"` 的 sleep、后台子壳、管道各段）是它的子孙，
 *      Node（含 execFile 的 `timeout`）不会碰 ⇒ 取消后"命令照跑满"。故本函数把 bash 放到
 *      **自己的进程组**（`detached`），取消 / 超时 / 输出溢出三种"我们主动杀"的时刻都按组补
 *      一刀 SIGKILL（见 ShellRuntime.killGroup）—— 三处原本是同一个孤儿缺口；
 *   ③ **spawn / IO 失败**（`err.code` ∈ ENOENT / EACCES / ENOTDIR…，**数字之外**）⇒ **失败**（##332）：
 *      这不是"命令报了错"，是**命令根本没跑起来**（cwd 不存在 / 不可进入、`/bin/bash` 缺失）——
 *      它没有退出码可言，也不该当结果。正文 `[命令未能启动 <code>] <Node 原文>（工作目录：…）`；
 *      带 cwd 是因为 Node 的 message（`spawn /bin/bash ENOENT`）会把"目录进不去"掩盖成"bash 不在"。
 *      ⚠️ 判据分界只有一条：**`err.code` 是数字 = 命令跑起来了（① 档）；否则 = 没跑起来（③ 档）**。
 *      ⚠️ 两条到达路径都要接住：`err.code` 非数字的 **'error' 事件**，和 spawn 的**同步抛**
 *      （cwd 是普通文件 ⇒ ENOTDIR，Node 在 spawn 内直接 throw、**不走 callback**；实测 node 24）。
 *    对照：`read` 的 execute 特意**相反**（读不到就抛），见 buildTools 里 read 的注释。
 */
// 导出给单测：`outcome` 的映射（##408 刀 5）必须能被**真跑**验证，不能只有类型可信。
export function runBash(
    command: string,
    cwd: string,
    limits: ShellLimits,
    signal?: AbortSignal,
    hooks?: BashRunHooks,
    /**
     * 本次调用的超时（毫秒）。`undefined` = 用 `limits.bashTimeoutMs`；`0` = **不设超时**。
     *
     * 为什么是参数而不是改 limits：超时是**这次执行的实参**（模型说"这活要跑 10 分钟"），
     * 而 limits 是人配的上限。两者混在一起，"临时放宽一次"就得改全局配置。
     */
    timeoutMs?: number,
    /** 用哪个 shell。缺省 = 包内兜底（`bash` 走 PATH）；宿主由 buildTools 按工具名显式传入。 */
    shell: ShellSpec = FALLBACK_SHELL,
    /** 平台能力（detached / 杀整组）。缺省 = 包内兜底（POSIX 杀进程组）；宿主传自己的 os 策略。 */
    runtime: ShellRuntime = defaultShellRuntime,
): Promise<BashRun> {
    // **同步**取：runBash 的执行器里有 onControl（转后台交接），await 会把它推到微任务之后。
    return new Promise((resolve) => {
        /** 本次生效的超时：0 = 不设（`setTimeout(0)` 会立刻开火，故 0 必须跳过而不是照传） */
        const effectiveTimeoutMs = timeoutMs === undefined ? limits.bashTimeoutMs : Math.max(0, Math.floor(timeoutMs));
        if (signal?.aborted) {
            // 还没起进程就取消了：头照给（字段齐全），耗时 / 字节都是 0
            resolve({
                text:
                    renderBashHead({
                        ok: false,
                        duration_ms: 0,
                        timeout_ms: effectiveTimeoutMs,
                        timed_out: false,
                        killed: false,
                        truncated: false,
                        stdout_bytes: 0,
                        stderr_bytes: 0,
                        cwd,
                    }) + "[已取消]",
                failed: false,
                outcome: "canceled",
            });
            return;
        }
        // Windows 上没装 Git Bash 等任何 bash：**在 spawn 之前**收口，给一条能照着办的错误，
        // 不把 `spawn bash.exe ENOENT` 这种原生文案丢给模型（用户看到的就是「没有可用工具」）。
        if (shell.missing) {
            resolve({
                text:
                    renderBashHead({
                        ok: false,
                        duration_ms: 0,
                        timeout_ms: effectiveTimeoutMs,
                        timed_out: false,
                        killed: false,
                        truncated: false,
                        stdout_bytes: 0,
                        stderr_bytes: 0,
                        cwd,
                    }) + `[命令未能启动] ${noShellHint([shell])}（工作目录：${cwd}）`,
                failed: true,
                outcome: "fail",
            });
            return;
        }
        /** abort 补刀的注销器（settle 时解绑，避免监听器随轮次泄漏） */
        let offAbort: (() => void) | undefined;
        /** 超时定时器（settle 时清掉） */
        let timeoutId: NodeJS.Timeout | undefined;
        /** 起跑时刻（`duration_ms` 的起点）：放在 spawn 之前，含建进程的开销 */
        const startedAt = Date.now();
        /**
         * 进程**真正被创建**的时刻（`spawn` 返回那一刻）；转后台时用它当 run 的 `startedAt`。
         *
         * 为什么不与 `startedAt` 共用（##408 review）：`duration_ms` 要含建进程开销才诚实，
         * 而 run 的「起了多久」该从进程真正存在那刻算。两个语义挤一个变量，改一边就会歪另一边。
         */
        let launchedAt = 0;
        // ── 下面这几项 settle 与 try 两处都要用（settle 在 try 外定义，收尾要读它们）──
        // 输出按**块**攒（不逐块拼字符串）：上限判据只要长度计数，逐块 `byteLength` 是 O(n²)
        const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
        const len = { out: 0, err: 0 };
        const dump = (side: "out" | "err"): string => Buffer.concat(chunks[side], len[side]).toString("utf8");
        /** 结局是否已落（Promise 本身只认第一次，这里只是别再做无用功 / 别多杀） */
        let done = false;
        /** 我们主动杀的（超时 / 取消 / 输出溢出）—— 对应 execFile 的 `killed` */
        let killed = false;
        /**
         * 释放 stdout/stderr 管道（spawn 成功后才会被赋值）：同步抛（cwd 是普通文件 ⇒ ENOTDIR）时
         * `child` 根本没建出来，settle 碰它就是 TDZ 崩 —— 用这个"句柄"隔一层，见下方结算处注释。
         */
        let destroyPipes: (() => void) | undefined;
        /**
         * 全部结局只在这里落一次（成功 / 各失败档）；
         * 'close' / 'error' / 取消 / 超时 / 同步 catch 共用同一判定。
         *
         * `timedOut` 由**超时那条路**显式传进来（不从 `killed` 猜）：`killed` 一个位服务三条主动
         * 路径（超时 / 输出溢出 / 取消），只有调用点知道是哪一条（见 ##419）。
         */
        const settle = (
            err: BashExecError,
            stdout: string,
            stderr: string,
            sig?: string | null,
            timedOut = false,
        ): void => {
            offAbort?.();
            offAbort = undefined;
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }
            // 结案即刻**释放管道**（##419）：超时 / 取消时子进程可能还活着（后台作业换了
            // session/pgid ⇒ 组杀打空），它的子孙仍握着 stdout/stderr 写端 —— 不 destroy 就每挂
            // 一次泄 2 个 fd。`done` 闸门已挡住后续数据，destroy 只影响"谁还握着写端"。
            destroyPipes?.();
            destroyPipes = undefined;
            const out = [stdout, stderr].filter(Boolean).join("\n");
            /** 结果头（##419）：字段名 / 顺序由 BASH_RESULT_HEAD_SCHEMA 派生，正文一律原文 */
            const head = (h: { ok: boolean; exitCode?: number; signal?: string | null }): string =>
                renderBashHead({
                    ok: h.ok,
                    exit_code: h.exitCode,
                    duration_ms: Date.now() - startedAt,
                    timeout_ms: effectiveTimeoutMs,
                    timed_out: timedOut,
                    killed: killed || err?.killed === true,
                    // 投递层（toModelOutput + markBashTruncated）按 capToolOutput 的结果改写成 true；
                    // 这一份是**原文**，原文就是完整的 ⇒ 恒 false
                    truncated: false,
                    stdout_bytes: len.out,
                    stderr_bytes: len.err,
                    cwd,
                    signal: h.signal ?? undefined,
                });
            // ⚠️ 这里一律返回**完整**文本（不 clip）：发给模型的那一份由 `capToolOutput` 在
            //    投递层现算（##127）—— 在 execute 里裁 = 落进 ops 的原文当场丢。
            //
            // `outcome` 只给 job 账本（##408 刀 5），**不参与** ✓/✗ 判定（`failed` 的判据见文件头）
            if (err?.name === "AbortError")
                resolve({ text: head({ ok: false }) + "[已取消]", failed: false, outcome: "canceled" });
            else if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err?.code === "ENOBUFS")
                resolve({
                    text:
                        head({ ok: false }) +
                        `[输出超过 ${fmtBytes(BASH_MAX_BUFFER_BYTES)} 上限，命令已终止；以下是已收到的部分]\n${out}`,
                    failed: false,
                    outcome: "fail",
                });
            else if (err?.killed)
                // 带上时长与出路：模型看到「30s 被杀」才会去 nohup / 分批，只写「超时」它会原样重试
                resolve({
                    text:
                        head({ ok: false, signal: sig }) +
                        `[命令超时被杀]（超过 ${fmtTimeout(effectiveTimeoutMs)}，由本步显式给 timeout 指定；缺省是不设超时。长任务请后台跑 + 取增量日志）\n${out}`,
                    failed: false,
                    outcome: "timeout",
                    ...(sig ? { signal: sig } : {}),
                });
            else if (typeof err?.code === "number")
                // 命令级非零退出（##353）：有 stderr = 失败，无 stderr = 查询未命中（数据）
                resolve({
                    text:
                        head({ ok: err.code === 0, exitCode: err.code, signal: sig }) +
                        `[退出码 ${err.code}]\n${out || "(无输出)"}`,
                    failed: stderr.trim().length > 0,
                    outcome: err.code === 0 ? "ok" : "fail",
                    exitCode: err.code,
                    ...(sig ? { signal: sig } : {}),
                });
            else if (err)
                // spawn / IO 失败（##332 ③）：命令**根本没跑起来** —— 失败档（execute 据此抛错）
                resolve({
                    text:
                        head({ ok: false }) +
                        `[命令未能启动 ${typeof err.code === "string" ? err.code : "?"}] ${err.message ?? ""}（工作目录：${cwd}）${out ? `\n${out}` : ""}`,
                    failed: true,
                    outcome: "fail",
                });
            else
                resolve({
                    text: head({ ok: true, exitCode: 0 }) + (out || "(无输出)"),
                    failed: false,
                    outcome: "ok",
                    exitCode: 0,
                });
        };
        try {
            // ⚠️ 为什么不用 execFile（##375 实测，别改回去）：`execFile` 把选项**白名单**转发给
            //    spawn（node 24 `lib/child_process.js`：只传 cwd/env/gid/shell/signal/uid/
            //    windowsHide/windowsVerbatimArguments）—— **`detached` 被静默丢掉**，于是
            //    "detached + 杀进程组"这条修法在 execFile 下失效（实测：pgid 仍是父进程那个组，
            //    `kill(-pid)` 当场 ESRCH，子孙照样跑满）。要进程组就只能自己 spawn，并顺手接住
            //    execFile 原本代劳的那几件事（攒输出 / maxBuffer / 超时 / 错误形状）——
            //    形状与 execFile **逐字段同构**，判据仍只有 settle 那一处。
            //
            // ⚠️ `stdio` 必须显式给（##418 实测）：缺省是 `['pipe','pipe','pipe']` ⇒ 子进程 fd0 是
            //    **socketpair**（不是 tty、也不是 /dev/null）。ripgrep 用 `is_file / is_fifo / is_socket`
            //    启发式判断「stdin 可读吗」，socket 即判可读 ⇒ **放弃搜 `./`、改读 stdin** ⇒ 没人写
            //    就阻塞到工具超时（实测：不带路径的 `rg` 跑满 300s，user CPU 只用几毫秒）。
            //    `ignore`（= /dev/null）让它正常搜 cwd；`cat`（无参）/ 无文件参数的 `grep` 也立刻拿到 EOF。
            //    stdout / stderr 必须仍是 `pipe`：超时 / 溢出 / 取消三条判据都依赖 `onData`。
            const inv = buildInvocation(shell, command);
            const child = spawn(inv.file, inv.args, {
                cwd,
                // Windows 的 detached（CREATE_NEW_PROCESS_GROUP）会让 PowerShell 5.1 丢 stdout 管道；
                // 那边杀树走 taskkill /T，不依赖进程组 ⇒ 按能力位决定，不做平台名分支。
                detached: runtime.processGroups,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            // 管道释放句柄交给 settle（它跨 try 作用域，不能直接碰 child）
            destroyPipes = () => {
                child.stdout?.destroy();
                child.stderr?.destroy();
            };
            if (child.pid !== undefined) {
                // 组名册（##408 刀 10）：宿主在 `onSpawn` 里记下"这个组是我起的" —— 之后命令里
                // 自己 `nohup xxx &` 起的子孙即使被 reparent 到 launchd，也能按组认领回来。
                // 本层不认识任务 / 名册（##515 搬包）：记账是宿主的账。
                hooks?.onSpawn?.(child.pid);
                // 进程真被创建了才有"起跑时刻"（cwd 同步抛的那条走不到这里）
                launchedAt = Date.now();
            }
            const finish = (err: BashExecError, o: string, e: string, timedOut = false, sig?: string): void => {
                if (done) return; // settle 内部（唯一落点）负责解绑 abort 监听与超时定时器
                done = true;
                settle(err, o, e, sig ?? child.signalCode, timedOut);
            };
            /**
             * 转后台之后的写入口（`handoff` 设置）。
             *
             * 顺序有意：**先看它再看 `done`** —— 交接时 `done` 会被置真（本函数不再落 settle），
             * 若按原顺序提前返回，转后台后的输出就全丢了（子进程还在写，只是没人接）。
             */
            let logSink: ((b: Buffer) => void) | undefined;
            /** 攒输出 + 上限（与 execFile 同口径：stdout / stderr **各算各的**，超了即杀、留已收到的部分） */
            const onData = (chunk: Buffer, side: "out" | "err"): void => {
                if (logSink) {
                    logSink(chunk);
                    return;
                }
                if (done) return;
                const keep = BASH_MAX_BUFFER_BYTES - len[side];
                const taken = keep >= chunk.length ? chunk : chunk.subarray(0, keep);
                chunks[side].push(taken);
                len[side] += taken.length;
                // job 输出环（##408 刀 5）：喂**真实收到**的字节（超上限那部分本就没进内存）
                if (taken.length > 0) hooks?.onChunk?.(taken);
                if (len[side] < BASH_MAX_BUFFER_BYTES) return;
                killed = true;
                runtime.killGroup(child); // 溢出也杀整组（原先 execFile 只杀直接子进程）
                finish({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, dump("out"), dump("err"));
            };
            child.stdout?.on("data", (c: Buffer) => onData(c, "out"));
            child.stderr?.on("data", (c: Buffer) => onData(c, "err"));
            // spawn 层失败（ENOENT / EACCES…）：execFile 把它转成 callback 的 err，这里接 'error' 事件。
            // 同步抛（cwd 是普通文件 ⇒ ENOTDIR）两条路都到不了这里，由外层 catch 接（见下）。
            child.on("error", (e: NodeJS.ErrnoException) =>
                finish({ code: e.code, message: e.message }, dump("out"), dump("err")),
            );
            // 收尾唯一入口：'close'（stdio 全关之后）——与 execFile 同一事件，输出不会截尾。
            child.on("close", (code) => {
                if (code === 0) finish(null, dump("out"), dump("err"));
                else
                    finish(
                        { code, killed, message: `Command failed: ${shell.label} ${command}` },
                        dump("out"),
                        dump("err"),
                    );
            });
            // ── 退出宽限（##454）：命令**已经结束**但 'close' 可能永远不来 ──
            // 'close' 的语义是「stdio 全关之后」；命令自己 `nohup … &` / `Popen` 起的孙进程会
            // 继承 stdout/stderr 写端，命令退出了它们还握着 ⇒ 'close' 挂到孙进程死为止
            // （##451 实证：最长一条 4,953s，两条都是这种形状）。
            // 所以再挂一条 'exit'：**命令退出 = 结局已定**，最多等 EXIT_GRACE_MS 收下残余输出，
            // 然后收尾（`settle` 里的 `destroyPipes` 会把流关掉，孙进程再写就是 EPIPE，是它自己的事）。
            // 正常命令 'close' 几乎总是早于宽限到点 ⇒ `done` 已真，这里整个 no-op，语义不变。
            const EXIT_GRACE_MS = 200;
            child.on("exit", (code, exitSignal) => {
                if (logSink) return; // 已转后台：输出归 logSink，**不截断**
                const grace = setTimeout(() => {
                    if (done || logSink) return;
                    if (code === 0) finish(null, dump("out"), dump("err"));
                    else
                        finish(
                            { code, killed, message: `Command failed: ${shell.label} ${command}` },
                            dump("out"),
                            dump("err"),
                            false,
                            exitSignal ?? undefined,
                        );
                }, EXIT_GRACE_MS);
                // 不拖住进程退出（Electron 主进程 / 单测进程都不该为这条定时器多活 200ms）
                grace.unref?.();
            });
            // 超时：自己计时（不用 execFile 的 timeout —— 它只杀直接子进程，同一类孤儿缺口）
            // `effectiveTimeoutMs === 0` = 显式不设超时（长任务），此时不留定时器。
            //
            // ⚠️ **先收尾、再杀组**（##419，与下面 onAbort 同构）：只杀不收尾是"永挂"的根因 ——
            //    后台作业（`&` + disown / 自己 setsid 的 Electron）换了 session/pgid ⇒ `kill(-pid)`
            //    打空，它（或它的子孙）仍握着 stdout/stderr 写端 ⇒ `'close'` **永远不到** ⇒ Promise
            //    永不 resolve（实测 30.2 / 82.4 分钟，铁证见 `~/.diy/log/agent-bash.jsonl`）。
            //    超时这一刻结局**已经确定**，没理由再等一个可能永不到来的事件。
            //    `signal` 显式给 "SIGKILL"：紧接着就发，不等 'close' 回填 signalCode。
            if (effectiveTimeoutMs > 0) {
                timeoutId = setTimeout(() => {
                    killed = true;
                    finish({ code: null, message: "timeout", killed: true }, dump("out"), dump("err"), true, "SIGKILL");
                    runtime.killGroup(child);
                }, effectiveTimeoutMs);
            }
            if (signal) {
                // 取消（用户停止 → ctrl.abort）：**先**钉 AbortError 结局、**再**杀整组。
                // 顺序有意：这是一条"肯定结束了"的路径，不必等 close 事件（组杀完 close 才到，
                // 中间那段 UI 会显示"还在跑"）；而杀组要在 bash 还活着时发，组 id 才有效。
                const onAbort = (): void => {
                    killed = true; // 头里 killed 如实置位（紧接着就发 SIGKILL，与超时同构）
                    finish(
                        { name: "AbortError", code: "ABORT_ERR", message: "The operation was aborted" },
                        dump("out"),
                        dump("err"),
                    );
                    runtime.killGroup(child);
                };
                signal.addEventListener("abort", onAbort, { once: true });
                offAbort = () => signal.removeEventListener("abort", onAbort);
            }
            // ── 转后台句柄（##408 刀 19）──
            // 放在三条"撤火路径"（超时 / abort / 溢出）都挂完之后：句柄一给出，调用方随时可能
            // 在下一 tick 调 `handoff`，那三样必须都已经存在，撤的时候才不会漏。
            if (child.pid !== undefined && hooks?.onControl) {
                hooks.onControl({
                    child,
                    pid: child.pid,
                    // 真正起跑时刻（不是含建进程开销的那个 `startedAt`）
                    startedAt: launchedAt || startedAt,
                    ended: () => done || child.exitCode !== null || child.signalCode !== null,
                    handoff: (write) => {
                        if (logSink) throw new DetachError({ code: "agent/job-already-detached", message: "已转后台" });
                        // 结束的进程没有"转"这回事：如实拒绝，别假装转成功再补一条"其实早结束了"
                        if (done || child.exitCode !== null || child.signalCode !== null)
                            throw new DetachError({ code: "agent/job-already-ended", message: "命令已结束" });
                        // ① 本函数不再落 settle（收口唯一归 run 表；否则双写终态、双发通知）
                        done = true;
                        // ② 超时定时器：不撤 ⇒ 5 分钟后把刚转后台的活杀掉（人以为它在跑）
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = undefined;
                        }
                        // ③ 轮次 abort：不摘 ⇒ 用户点"停止本轮"会把刚转后台的活一起带走
                        offAbort?.();
                        offAbort = undefined;
                        // ④ 前半段一个字节都不许丢：先交给调用方落盘，再切换去向
                        const buffered = Buffer.concat([...chunks.out, ...chunks.err], len.out + len.err);
                        chunks.out.length = 0;
                        chunks.err.length = 0;
                        len.out = 0;
                        len.err = 0;
                        // ⑤ 读端**不 destroy**：子进程还往这个 pipe 写，关了它 64KB 就阻塞
                        logSink = write;
                        return buffered;
                    },
                    finishAsDetached: (text) => {
                        // 没交接就收尾 = 调用方顺序错了（那时 `done` 还是假，说明它想让本函数
                        // "当没发生过" —— 那会把真正的结局吞掉，不如直接报错）
                        if (!logSink) throw new DetachError({ code: "agent/job-not-detached", message: "尚未转后台" });
                        resolve({ text, failed: false, outcome: "ok" });
                    },
                });
            }
        } catch (e) {
            // ⚠️ **同步抛是真实路径**，不是防御性代码：cwd 是普通文件时 Node 在 spawn 内直接
            //    `throw new ErrnoException(err, "spawn")`（code=ENOTDIR），**不走 callback**（实测 node 24）。
            //    漏接这条 catch 的后果不是"错误被吞"（executor 抛 = Promise reject，结果同向也是 ✗），
            //    而是文案只剩裸 `spawn ENOTDIR`、落不进本函数的统一口径（带 cwd 的失败文案）。
            settle(e as BashExecError, "", "");
        }
    });
}

