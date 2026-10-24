// 🎯 一条 run 的**表格视图**（纯函数，零 IO）—— ##408 刀 9
//
// 用户 2026-10-23：「先开发页面，不然不知道是怎么运转的，**把原始命令行要显示出来**。
// 表格形式，各种字段。」
//
// 为什么把"字段拼装"单独放一层：面板、CLI、将来的导出**必须看同一份字段口径**
// （时长怎么算、pid 没有时说什么、来源怎么拼成一行）。写在 renderer 里就只有一个消费者，
// 没法单测，也必然会和 CLI 漂。
//
// 与注册表的关系：注册表持有**事实**（state / pid / startedAt / exitCode…），
// 这里只做**呈算**（拼字、算时长、截首行）—— 不引入新事实、不读盘（字节数由调用方给）。

import { formatDuration, exitText, stateLabel, type RunLike, type RunState } from "./run-status";
import type { OwnedProc } from "./proc-scan";

/** 来源锚点（与 `main/services/run-registry.ts::RunOrigin` 同形；shared 不许反向依赖 main）。 */
export interface RunOriginRef {
    taskUri: string;
    turnId?: string;
    stepId?: string;
    toolCallId?: string;
}

export interface RunFact extends RunLike {
    pid?: number;
    cwd: string;
    title?: string;
    dir: string;
    logPath: string;
    origin?: RunOriginRef;
    error?: string;
    /** 前台 run（工具调用正在等结果）；后台为 false/undefined */
    foreground?: boolean;
    /** 根命令已退出、但进程组里还有活口（长活就是这种：`nohup … &`） */
    awaitingGroup?: boolean;
    /** 曾经有过后台子孙（收口后 `awaitingGroup` 清掉，但这个事实留着） */
    hadSurvivingGroup?: boolean;
    /** 结束通知是否已投递（"agent 会不会被叫醒"的可见证据） */
    notified?: boolean;
}

export interface RunView {
    id: string;
    /** 原始状态 */
    state: RunState;
    /** 人话状态（运行中 / 已结束 / 已被杀 / 启动失败） */
    stateLabel: string;
    /** 终态 = 不会自己再变（前端据此决定要不要继续刷） */
    terminal: boolean;
    /** 进程型才有；进程内 JS 任务为 null */
    pid: number | null;
    /** 一行标题（缺省 = 命令首行） */
    title: string;
    /** **原始命令行全文**（多行保留；用户点名要看这个，不许截） */
    command: string;
    /** 命令首行（表格窄列用） */
    commandFirstLine: string;
    cwd: string;
    startedAt: number;
    startedAtText: string;
    endedAt: number | null;
    endedAtText: string | null;
    durationMs: number;
    durationText: string;
    exitCode: number | null;
    signal: string | null;
    /** 退出情况的唯一表述（退出码 0 / 信号 SIGTERM / （未结束）） */
    exitText: string;
    /** 输出文件字节数（调用方 stat；读不到给 null） */
    outputBytes: number | null;
    outputText: string;
    logPath: string;
    dir: string;
    origin: RunOriginRef | null;
    /** 来源一行话：`projects/4/tasks/408 · t179… · call_…` */
    originText: string;
    error: string | null;
    /** 前台 run（`bash` 没给 `background`）—— 表格里标出来 */
    foreground: boolean;
    /** 根命令退了、后台子孙还在跑 —— 表格里标「后台」 */
    awaitingGroup: boolean;
    /** 后台 run（`background:true`）—— 表格「类型」列 */
    background: boolean;
    /** 类型人话：后台 / 前台（前台 = 工具调用正在等它的结果） */
    modeText: string;
    /**
     * 进程组号。detached spawn ⇒ **pgid 恒等于根 pid**，所以这里就取 pid；
     * 台前台后没有区别（都是 `detached:true`）。进程内任务两者都 null。
     */
    pgid: number | null;
    /** 曾经留下过后台子孙 */
    hadSurvivingGroup: boolean;
    /** 结束通知已投递 */
    notified: boolean;
}

/** 本地时间 `HH:MM:SS`（表里只放到秒：作业的生命周期不是审计，不必到毫秒）。 */
export function clockText(ts: number): string {
    const d = new Date(ts);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 标题：给了就用给的，否则取命令首行（去掉首尾空白，空命令给占位）。 */
export function titleOf(command: string, title?: string): string {
    const t = (title ?? "").trim();
    if (t) return t;
    const head = (command.split("\n")[0] ?? "").trim();
    return head || "（空命令）";
}

/** 来源一行话。`taskUri` 是必需的（没有来源锚点的 run 不该进这张表）。 */
export function originTextOf(origin: RunOriginRef | undefined): string {
    if (!origin) return "—";
    const parts = [origin.taskUri];
    if (origin.turnId) parts.push(origin.turnId);
    if (origin.stepId) parts.push(origin.stepId);
    if (origin.toolCallId) parts.push(origin.toolCallId);
    return parts.join(" · ");
}

/**
 * 事实 → 视图。
 *
 * `now` 由调用方给（测试注入假钟）—— 时长必须能在"还在跑"时也算得出来，
 * 所以不许用 `Date.now()` 藏在这里。
 */
export function runViewOf(fact: RunFact, now: number, outputBytes?: number | null): RunView {
    const end = fact.endedAt ?? null;
    const durationMs = Math.max(0, (end ?? now) - fact.startedAt);
    return {
        id: fact.id,
        state: fact.state,
        stateLabel: stateLabel(fact.state),
        terminal: fact.state !== "running",
        pid: fact.pid ?? null,
        title: titleOf(fact.command, fact.title),
        command: fact.command,
        commandFirstLine: (fact.command.split("\n")[0] ?? "").trim(),
        cwd: fact.cwd,
        startedAt: fact.startedAt,
        startedAtText: clockText(fact.startedAt),
        endedAt: end,
        endedAtText: end === null ? null : clockText(end),
        durationMs,
        durationText: formatDuration(durationMs),
        exitCode: fact.exitCode ?? null,
        signal: fact.signal ?? null,
        exitText: exitText(fact.state, fact.exitCode ?? null, fact.signal ?? null),
        outputBytes: outputBytes ?? null,
        outputText: outputBytes === null || outputBytes === undefined ? "—" : bytesText(outputBytes),
        logPath: fact.logPath,
        dir: fact.dir,
        origin: fact.origin ?? null,
        originText: originTextOf(fact.origin),
        error: fact.error ?? null,
        foreground: fact.foreground === true,
        awaitingGroup: fact.awaitingGroup === true,
        background: fact.foreground !== true,
        modeText: fact.foreground === true ? "前台" : "后台",
        pgid: fact.pid ?? null,
        hadSurvivingGroup: fact.hadSurvivingGroup === true,
        notified: fact.notified === true,
    };
}

/** 字节数的人话（表格列宽有限；K/M 一位小数够了）。 */
export function bytesText(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
    return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * **未登记**的进程行（##408 刀 10）—— 命令里自己 `nohup xxx &` 起的那种：
 * 它从没经过 `run-registry`，但在 `ps` 里归我们管（判据见 `shared/proc-scan.ts`）。
 *
 * 为什么要单独一张表：直接把它塞进 `RunView` 会让"run"这个词失真 ——
 * run 有 origin、有落盘目录、有终态；这条只有一个 pid 和一段命令行。
 * 两者共用**表格列**（`TableRow`），但不共用模型。
 */
export interface ProcRow {
    /** `pid:<n>` —— 表格行键，和 run 的 `r-…` 不会撞 */
    id: string;
    pid: number;
    pgid: number;
    ppid: number;
    /** 一行标题（命令首行） */
    title: string;
    /** 原始命令行全文 */
    command: string;
    /** 已运行时长 */
    elapsedMs: number | null;
    elapsedText: string;
    /** CPU%（ps 的采样平值，只作参考） */
    cpuText: string;
    /** 内存常驻 */
    memText: string;
    /** 它属于哪条 run（`null` = 连 run 都没有的野进程） */
    runId: string | null;
    /** 哪个 bash 调用留下的（有就显示，回答"这堆进程是谁起的"） */
    groupText: string;
    /** 进程组组长的原始命令（tooltip 用；没有给 null） */
    groupCommand: string | null;
    /** 那条命令属于哪个任务（面板据此只在"本任务"里列它；不知道给 null） */
    taskUri: string | null;
}

/** ps 的 KiB → 人话（1024 进制；表格里只留一位小数，够判断数量级）。 */
export function memTextOf(rssKb: number | null): string {
    if (!rssKb || rssKb <= 0) return "—";
    if (rssKb < 1024) return `${rssKb}K`;
    return `${(rssKb / 1024).toFixed(1)}M`;
}

/** 一条"野进程" → 表格行。`elapsedMs` 由调用方给（`ps` 的 etime 解析在 main 侧）。 */
export function procRowOf(
    proc: OwnedProc,
    elapsedMs: number | null,
    group?: { command: string; runId?: string; taskUri?: string; at: number },
): ProcRow {
    return {
        id: `pid:${proc.pid}`,
        pid: proc.pid,
        pgid: proc.pgid,
        ppid: proc.ppid,
        title: titleOf(proc.command),
        command: proc.command,
        elapsedMs,
        elapsedText: formatDuration(elapsedMs ?? undefined),
        cpuText: proc.pcpu === null ? "—" : `${proc.pcpu.toFixed(1)}%`,
        memText: memTextOf(proc.rssKb),
        runId: proc.runId,
        groupText: group ? `bash · ${group.command.split("\n")[0] ?? ""}` : "—",
        groupCommand: group?.command ?? null,
        taskUri: group?.taskUri ?? null,
    };
}

/**
 * 面板默认视图该不该显示这条 run（##408 用户 1888：「我不要他很快结束的进程」）。
 *
 * 判据（放大到"含前台"时全部显示）：
 *   · 后台 run —— 永远显示（那是用户要管的东西）；
 *   · 前台 run —— 只有**正在跑**、**失败**、或**留下过后台子孙**（`nohup … &`，父命令
 *     35ms 就退但活还在）才显示；`ls`/`rg` 这类毫秒级过路命令默认挡掉。
 *
 * 抽成纯函数：这条判据直接决定"用户能不能看见他的长活"，值得被单测钉住。
 */
export function worthShowing(run: RunView, showForeground: boolean): boolean {
    if (showForeground) return true;
    if (!run.foreground) return true;
    // 失败要看**两处**：状态（起不来 / 被信号杀）与退出码（命令跑了但报错，状态仍是 exited）
    const failed = run.state === "failed" || (run.exitCode !== null && run.exitCode !== 0) || run.signal !== null;
    return run.state === "running" || failed || run.hadSurvivingGroup === true;
}
