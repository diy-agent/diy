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
    };
}

/** 字节数的人话（表格列宽有限；K/M 一位小数够了）。 */
export function bytesText(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
    return `${(n / (1024 * 1024)).toFixed(1)}M`;
}
