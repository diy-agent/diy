/**
 * job-runs-view.ts — spawned job 的**只读展示口径**（##408 刀 6；纯函数、零 IO、零 DOM）。
 *
 * ── 为什么要单独一层 ──
 *   刀 5 已经把「job 是什么」落成数据（`JobRun` + `origin`），但**怎么把它摆给人看**是另一套判断：
 *   这一条属于哪个任务、能不能点回去、状态灯是什么颜色、一行摘要写什么。这些判断必须在
 *   **面板 / 单测 / 将来的意图测试**三处是同一份 —— 各写一遍 if，必然有一天「列表说成功、详情说失败」。
 *
 * ── 依赖方向（硬规矩）──
 *   本文件只许依赖 `shared/*`（`job-run` / `spawned-job` / `task-uri`）。
 *   `LiveRunView` 住在 `main/services/spawned-jobs.ts` —— renderer 不该反向依赖 main，
 *   故这里声明一份**结构子集** `LiveRunRef`；main 那份接口天然可赋值给它（多字段不碍事）。
 *
 * ── 一条硬约束（用户 20:5x 点名的第 3 条）──
 *   「指不回去的 job **不显示成可点**」：`navTargetOf()` 是唯一判据 —— 非 `spawned` 分支、
 *   或锚点字段残缺，一律 `null`。UI 见到 null 就渲染成**纯文本**，不做「点了没反应」的假按钮。
 */

import type { JobOrigin, JobRun, JobRunState } from "./job-run";
import { fmtDuration } from "./spawned-job";
import { isTaskUri } from "./task-uri";

// ═══════════════════════════════════════════════
//  进程内活体视图（结构子集；真源 main/services/spawned-jobs.ts::LiveRunView）
// ═══════════════════════════════════════════════

/** 在跑、可能还没落账的一条（`diy job ls` 的 `live` 字段）。 */
export interface LiveRunRef {
    readonly runId: string;
    readonly jobId: string;
    readonly title: string;
    readonly taskUri: string;
    readonly origin: JobOrigin;
    readonly startedAt: string;
    /** 已运行毫秒（main 侧按它的时钟算，别在 renderer 里再算一遍 —— 两边时钟不必同源） */
    readonly runMs: number;
    /** 是否已落过 `running` 行（false = 还在阈值之下 / 无输出，账上查不到） */
    readonly promoted: boolean;
    readonly pid: number | null;
    readonly output: {
        readonly capBytes: number;
        readonly bytes: number;
        readonly totalBytes: number;
        readonly droppedBytes: number;
    };
}

// ═══════════════════════════════════════════════
//  归属：这一条属于哪个任务
// ═══════════════════════════════════════════════

/**
 * 一条 run 的任务 URI（`null` = 与任务无关，例如 v2 的全局定时器）。
 *
 * 取值顺序：`origin.spawned.data.taskUri` → `owner` 里的 taskUri。
 * 为什么不只看 origin：`manual` / `trigger` 型没有 taskUri 但有 owner（会话内定时器的 owner 是 turn），
 * 只认 origin 会让它们在任务面板里消失；反过来只认 owner，则「别的 agent 起在本任务里」会算错。
 * ⇒ **先 origin（这次是谁在哪按的开始），再 owner（它属于谁）**。
 */
export function taskUriOfRun(run: { readonly origin: JobOrigin; readonly owner?: JobRun["owner"] }): string | null {
    if (run.origin.type === "spawned") return run.origin.data.taskUri;
    // 活体（`LiveRunRef`）没有 owner 字段 —— 缺了就是「查不到归属」，别猜
    return run.owner ? ownerTaskUri(run.owner) : null;
}

function ownerTaskUri(owner: JobRun["owner"]): string | null {
    return owner.type === "global" ? null : owner.taskUri;
}

/** 本任务名下、按时间升序的 run（面板列表的数据源）。 */
export function runsOfTask(runs: readonly JobRun[], taskUri: string): JobRun[] {
    return runs.filter((r) => taskUriOfRun(r) === taskUri);
}

/** 本任务名下正在跑的（含还没落账的短命令）。 */
export function liveOfTask(live: readonly LiveRunRef[], taskUri: string): LiveRunRef[] {
    return live.filter((v) => taskUriOfRun(v) === taskUri);
}

// ═══════════════════════════════════════════════
//  导航：这一条能不能点回源头
// ═══════════════════════════════════════════════

/** 「点来源」要去的地方：打开这个任务的会话，滚到这一轮的这个块并高亮。 */
export interface JobNavTarget {
    readonly taskUri: string;
    readonly turnId: string;
    /** 会话块 id（tool call 块的 `data-block-id`；与 `LocalChatPage::anchorRowIndex` 同一把尺） */
    readonly blockId: string;
}

/**
 * origin → 导航目标（`null` = **不可导航**，UI 必须渲染成纯文本）。
 *
 * 只有 `spawned` 可导航，理由逐条：
 *   · `spawned` —— `{taskUri, turnId, stepId, toolCallId}` 全是地址，块 id 直接命中会话里的 tool 块；
 *   · `trigger` —— 导航目标是「定时器详情」，v1 **没有定时器页**（v2 才有）⇒ 现在点了只能进空页，
 *                 宁可不可点（用户原话：别假装能跳）；
 *   · `manual` —— 用户自己点的「立即运行」，没有外部锚点（D6 原话：停在详情）；
 *   · `agent`  —— 只有 `memberUri + turnId`，**没有块 id** ⇒ 能到轮、到不了那一步，
 *                 而「到轮」与「到那一步」在长轮里是两个体验；v1 尚无真实数据，留到有数据时再定。
 *
 * 字段残缺（空串 / 非任务 URI）同样判不可导航：账是 append-only 的外部数据，
 * 手改 / 半行都可能让它残缺，UI 不能因此崩。
 */
export function navTargetOf(origin: JobOrigin | null | undefined): JobNavTarget | null {
    if (!origin || origin.type !== "spawned") return null;
    const d = origin.data;
    if (!isTaskUri(d.taskUri)) return null;
    if (!nonEmpty(d.turnId) || !nonEmpty(d.toolCallId)) return null;
    return { taskUri: d.taskUri, turnId: d.turnId, blockId: d.toolCallId };
}

function nonEmpty(v: unknown): boolean {
    return typeof v === "string" && v.length > 0;
}

// ═══════════════════════════════════════════════
//  状态灯：一句话说清「到哪了 / 怎么结束的」
// ═══════════════════════════════════════════════

/** 灯的语义（不是颜色 —— 颜色归主题，组件按它选 class）。 */
export type LampTone = "running" | "ok" | "warn" | "error" | "lost";

export interface StateBadge {
    readonly tone: LampTone;
    readonly text: string;
    /** 悬停的一句话解释（`text` 只有 2~4 字，不能自证） */
    readonly hint: string;
}

/**
 * `state` + `outcome` 合成一句人话。
 *
 * 为什么必须两字段一起看：四态把「超时 / 用户取消」都压在 `failed`（刀 2 定稿：被信号杀 = failed），
 * 只看 state 会把这两件事报成「失败」—— 而它们**不是缺陷**，画成红的会把人训练成忽略红点。
 * 这也是刀 5 加 `outcome` 的全部理由，本函数是它第一个消费者。
 */
export function stateBadgeOf(run: Pick<JobRun, "state" | "outcome" | "exitCode" | "signal">): StateBadge {
    const st: JobRunState = run.state;
    if (st === "running") return { tone: "running", text: "运行中", hint: "已启动，尚未观察到结束" };
    if (st === "lost")
        return { tone: "lost", text: "已失联", hint: "应用重启后进程已不在，且没有结束记录 —— 结局不可知" };
    if (st === "settled") return { tone: "ok", text: "完成", hint: codeHint(run, "退出码 0") };
    // failed 分三种：用户取消 / 超时 / 真失败
    if (run.outcome === "canceled") return { tone: "warn", text: "已取消", hint: "用户主动停止 —— 不是命令出错" };
    if (run.outcome === "timeout") return { tone: "warn", text: "超时", hint: "跑太久被超时终止 —— 不是命令出错" };
    return { tone: "error", text: "失败", hint: codeHint(run, "非零退出") };
}

function codeHint(run: Pick<JobRun, "exitCode" | "signal">, fallback: string): string {
    if (run.signal) return `被信号 ${run.signal} 终止`;
    if (run.exitCode !== undefined) return `退出码 ${run.exitCode}`;
    return fallback;
}

// ═══════════════════════════════════════════════
//  来源徽标与一行摘要
// ═══════════════════════════════════════════════

export interface OriginBadge {
    /** 行首图标（三类各一个，**形状不同才扫得快**） */
    readonly icon: string;
    /** 短标签（列里只放 2 字） */
    readonly short: string;
    /** 悬停说明（含导航目标 —— 让「点了会去哪」在点之前就说得清） */
    readonly hint: string;
    /** 与 `navTargetOf` 同一判据（UI 直接用这个，不必调两次） */
    readonly navigable: boolean;
}

/** origin → 行内徽标（`spawned` 的 hint 里写出完整的「任务 / 轮 / 步 / 块」地址）。 */
export function originBadgeOf(origin: JobOrigin): OriginBadge {
    const nav = navTargetOf(origin);
    switch (origin.type) {
        case "spawned": {
            const d = origin.data;
            return {
                icon: "▶",
                short: "会话",
                hint: nav
                    ? `会话里的工具调用 · ${d.taskUri} · 轮 ${d.turnId} · 步 ${d.stepId} · 块 ${d.toolCallId}\n点一下回到那一步`
                    : `会话里的工具调用 · ${d.taskUri}（锚点不全，无法定位）`,
                navigable: nav !== null,
            };
        }
        case "trigger":
            return {
                icon: "⏱",
                short: "定时",
                hint: `定时器 ${origin.data.jobId} 触发（${origin.data.reason}）· v1 没有定时器详情页，暂不可跳`,
                navigable: false,
            };
        case "manual":
            return {
                icon: "✋",
                short: "手动",
                hint: `${origin.data.by} 手动运行（cwd ${origin.data.cwd}）· 没有外部锚点`,
                navigable: false,
            };
        case "agent":
            return {
                icon: "🤖",
                short: "代理",
                hint: `由 ${origin.data.memberUri} 发起（轮 ${origin.data.turnId}）· 锚点只到轮、不到那一步`,
                navigable: false,
            };
    }
}

/**
 * 把多行输出摘成**最后一行**（列表里的「末行输出摘要」）。
 *
 * 为什么取最后一行而不是第一行：长命令的进度探针（`npm i` / 构建）真相在尾部；
 * 首行是「欢迎语」，永远一样、不含信息。空输出返回空串（调用方据此不渲染那一段）。
 */
export function lastLineOf(text: string | null | undefined, maxChars = 120): string {
    if (!text) return "";
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? "").trim();
        if (line.length === 0) continue;
        return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
    }
    return "";
}

/**
 * 列表一行的「耗时」文案。
 *
 * `ms` 缺省（running）就写**开始时刻**：不许拿 `Date.now()` 去减 —— renderer 与 main 的时钟
 * 不必同源，减出来的数与账本里的 `ms` 可能对不上（同一个东西两个数 = 又是一次分叉）。
 */
export function whenTextOf(run: Pick<JobRun, "startedAt" | "endedAt" | "ms">): string {
    if (run.ms !== undefined) return fmtDuration(run.ms);
    return `始于 ${shortTime(run.startedAt)}`;
}

/** ISO → `HH:MM:SS`（跨天带 `M/D`）。解析失败原样返回 —— 显示层不编造。 */
export function shortTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    const now = new Date();
    const sameDay =
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? hms : `${d.getMonth() + 1}/${d.getDate()} ${hms}`;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

// ═══════════════════════════════════════════════
//  合并成「面板的一行」（账本行 + 活体）
// ═══════════════════════════════════════════════

/**
 * 面板的一行 = 一次 run。
 *
 * 数据来自两处，必须合并成一行而不是并列两行：
 *   · 账本（append-only，一次 run 有 `running` + 终态两行）—— **按 runId 去重取最后一行**；
 *   · 活体（进程内、可能还没落账：阈值之下的短命令 / 无输出的长命令）。
 * 同一个 run 两边都有时以**活体为准判「在跑」**（账上的 `running` 行可能是没见过收口的残留，
 * 而活体表里已经没有它 = 进程确实结束了）。
 */
export interface RunRow {
    readonly runId: string;
    readonly jobId: string;
    readonly title: string;
    readonly origin: JobOrigin;
    readonly state: JobRunState;
    readonly outcome?: JobRun["outcome"];
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly ms?: number;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly summary?: string;
    /** 进程内可见的活体（在跑才有；null = 只能在账上看） */
    readonly live: LiveRunRef | null;
    /** 活体是否已落账（false = 账上没有它，纯进程内） */
    readonly promoted: boolean;
}

/**
 * 本任务的面板行，**最近的在前**。
 *
 * 为什么最近的在前：面板是「现在有什么在跑 / 刚跑完什么」，最新的是问题所在；
 * 历史越往下越旧，与聊天/日志的方向一致（这条不与 CLI 的升序冲突：CLI 是时间线，面板是现状）。
 */
export function rowsOfTask(
    runs: readonly JobRun[],
    live: readonly LiveRunRef[],
    taskUri: string,
): RunRow[] {
    const liveById = new Map<string, LiveRunRef>();
    for (const v of live) if (taskUriOfRun(v) === taskUri) liveById.set(v.runId, v);

    // 账本去重：同一 runId 取**最后**出现的一行（append-only ⇒ 后面的更新）
    const byId = new Map<string, JobRun>();
    for (const r of runs) if (taskUriOfRun(r) === taskUri) byId.set(r.id, r);

    const rows: RunRow[] = [];
    for (const [runId, r] of byId) {
        const v = liveById.get(runId) ?? null;
        rows.push({
            runId,
            jobId: r.jobId,
            title: r.title,
            origin: r.origin,
            // 活体还在 ⇒ 就是在跑（账上的 running 行可能是从未收口的残留）
            state: v ? "running" : r.state,
            ...(r.outcome !== undefined ? { outcome: r.outcome } : {}),
            startedAt: r.startedAt,
            ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
            ...(r.ms !== undefined ? { ms: r.ms } : {}),
            ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
            ...(r.signal !== undefined ? { signal: r.signal } : {}),
            ...(r.summary !== undefined ? { summary: r.summary } : {}),
            live: v,
            promoted: true,
        });
    }

    // 只在活体里出现的（还没落账）
    for (const [runId, v] of liveById) {
        if (byId.has(runId)) continue;
        rows.push({
            runId,
            jobId: v.jobId,
            title: v.title,
            origin: v.origin,
            state: "running",
            startedAt: v.startedAt,
            live: v,
            promoted: v.promoted,
        });
    }

    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return rows;
}
