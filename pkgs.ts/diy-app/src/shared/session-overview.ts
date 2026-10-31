/**
 * session-overview.ts — **全局会话可见性**（##308）的呈现判据（纯函数，renderer 与单测共用）。
 *
 * 数据源 = `agent.local.sessions`（注册表，`shared/registry-frame.ts` 的 `SessionEntry`）：
 *   一条**全局**订阅的「快照 + delta」，只搬状态（R2）。本文件把它翻成"人看的东西"：
 *   步数进度 / 待投递留言 / 谁在看 / 已跑多久 / 跨启动合并 / 总览行。
 *
 * 【##393 收编：状态判据不在这里了】
 *   运行状态 / 归因 / 图标语言 / 停滞 / 未读 / 排队 —— 唯一真源是 `shared/session-state`。
 *   本文件只保留**表格形状**的视图（步数进度、tooltip、总览行），且一律从 `sessionStateOf` 派生；
 *   改造前这里自有 `stalledOf` / `abnormalEndOf` / `sessionChipOf` 三份判据 + 一张配色表，
 *   是用户 3.3「四处显示不一致」的来源之一 —— 已删除，别再加回来。
 *
 * 【两条仍成立的约束】
 *   · **观测不污染（R3）**：这些函数只读注册表条目；`viewers` 是**数据**不是我们能改的东西。
 *   · **两源取大**：注册表（进程内）∪ 账本（跨启动）—— 谁更全用谁，不因账本晚到抹掉已有数字。
 */

import { endMarkOf } from "./turn-end";
import type { SessionEntry } from "./registry-frame";
import {
    abnormalEndOf,
    glyphOf,
    idleMsOf,
    isAbnormalBlame,
    newTurnsOf,
    queueViewOf,
    sessionStateOf,
    stalledOf,
    type SessionGlyphView,
} from "./session-state";
import { compareInstant } from "@diy-agent/time";

/** 此刻累计步数（在跑轮次的当前步 + 本进程内已收尾轮次的累计） */
export function stepsNow(e: SessionEntry): number {
    return e.totalSteps + (e.turn?.steps ?? 0);
}


/** 步数进度（`k/maxSteps`；`maxSteps` 未知时只给已跑步数，不编上限） */
export interface StepsProgress {
    done: number;
    limit: number | null;
    /** 0..1（limit 未知 → null，调用方不画进度条） */
    pct: number | null;
    text: string;
}

export function stepsProgressOf(e: SessionEntry, maxSteps: number | null): StepsProgress {
    const done = stepsNow(e);
    const limit = maxSteps && maxSteps > 0 ? maxSteps : null;
    return {
        done,
        limit,
        pct: limit ? Math.min(1, done / limit) : null,
        text: limit ? `${done}/${limit}` : `${done} 步`,
    };
}



/**
 * 「该不该先看」的位次（**越小越该看**）——排序与分组用同一把尺子。
 * 运行中 > 异常终止未读 > 未读 > 待投递留言 > 已对话（无话可说）。
 */
export type SessionAttention = 0 | 1 | 2 | 3 | 4;

/**
 * 会话在**有空间的地方**（任务管理表）该说什么：比 nav 多给「状态位次 + 步数 + token + 最后活动」，
 * 因为任务表空间大，不必像 nav 那样一个字一个字省。
 *
 * 判据**不再本文件另起一套**：状态/归因走 `sessionStateOf`，图标走 `glyphOf`（与 nav / 详情 / 总览
 * 同一个函数），本文件只说"这一格写哪几个字"。
 */
export interface SessionRowView {
    /** 状态位次（排序用；越小越该看） */
    attention: SessionAttention;
    /** 状态短文案（`运行中 3/200` · `已结束 · 上游服务` …） */
    state: string;
    /** 图标视图（四处同一份：形状=阶段，线型=待处理等级，颜色=归因） */
    glyph: SessionGlyphView;
    /** 未读消息条数（##358：1 轮 = 1 条，不是步数；0 = 没有未读） */
    unread: number;
    /** 本进程内累计 token */
    tokens: number;
    /** 最后一次活动时刻（ISO） */
    lastActivity: string;
}

/**
 * 会话在任务表里的「一行信息」（判据与 nav / 详情 / 总览**同源**，粒度更粗但结论必须一致）。
 * `totalTurns` = 跨启动总轮次（见 `newTurnsOf`）：不传就退回帧里的本进程计数。
 */
export function sessionRowOf(
    e: SessionEntry,
    seenTurns: number | null,
    maxSteps: number | null,
    now: number,
    totalTurns?: number,
): SessionRowView {
    const unread = newTurnsOf(e, seenTurns, totalTurns);
    const state = sessionStateOf({ entry: e, totalTurns, unread, now });
    // 传 uri 只为 tooltip 抬头（与 nav / 详情同一个图标视图，别让"同一会话四处说话"从 tip 开始）
    const glyph = glyphOf(state, uriOf(e));
    const base = { unread, tokens: e.totalTokens, lastActivity: e.lastActivity, glyph };

    if (state.run === "running") {
        const prog = stepsProgressOf(e, maxSteps);
        return {
            ...base,
            attention: 0,
            state: state.stalled ? `停滞 ${fmtDuration(idleMsOf(e, now) ?? 0)}` : `运行中 ${prog.text}`,
        };
    }
    if (state.run === "ended" && isAbnormalBlame(state.blame)) {
        return { ...base, attention: unread > 0 ? 1 : 4, state: glyph.label };
    }
    if (state.queued > 0) {
        return { ...base, attention: 3, state: queueViewOf(e).label };
    }
    if (unread > 0) {
        return { ...base, attention: 2, state: `未读 ${unread} 条` };
    }
    // 无事可报 ≠ 从没聊过：「已对话」与 nav 的终态圆说的是同一件事（同一个词、同一个判据）。
    return { ...base, attention: 4, state: "已对话" };
}

/** chip / 行的公用 tooltip：把这条会话的判据一次说全 */
/** 会话指向的 task uri（tip 抬头用；没有就退回会话 id） */
export function uriOf(e: SessionEntry): string {
    return e.refs.find((r) => r.kind === "task")?.uri ?? e.id;
}

export function tipOf(e: SessionEntry, maxSteps: number | null, now: number): string {
    const uri = uriOf(e);
    const lines = [`${uri}（会话 ${e.id}）`];
    if (e.turn) {
        const prog = stepsProgressOf(e, maxSteps);
        const runMs = Date.parse(e.turn.startedAt);
        lines.push(
            `在跑：${prog.text} 步 · 本轮 ${fmtTokens(e.turn.tokens)} tokens` +
                (Number.isFinite(runMs) ? ` · 已跑 ${fmtDuration(now - runMs)}` : ""),
        );
        if (e.turn.model) lines.push(`模型：${e.turn.model}`);
        if (e.turn.state === "detached") lines.push("此刻无人观察（轮次仍在跑，##305）");
    } else {
        lines.push(`已开始（此刻没在跑）：本进程内跑过 ${e.turnCount} 轮 / 累计 ${e.totalSteps} 步 · ${fmtTokens(e.totalTokens)} tokens`);
        const mark = endMarkOf(e.lastEndReason, false);
        if (mark.tip) lines.push(`上一轮：${mark.tip}`);
    }
    lines.push(`看客 ${e.viewers} · 待投递留言 ${e.queue}`);
    lines.push(`首次见到 ${e.firstSeenAt} · 最后活动 ${e.lastActivity}`);
    return lines.join("\n");
}

/** 两个 ISO 时刻取**后者**（任一缺 → 给另一个）。用途 = 「注册表（本进程）∪ 账本（跨启动）」
 *  这类双源字段取"更新的那个" —— 判据只有一条，别在每处再写一遍 `a > b ? a : b`。 */
export function mergeTs(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) return b;
    if (!b) return a;
    // 按**时刻**取后者（串的偏移可能不同，`a > b` 比的是字典序，跨格式会取反，##483）
    return compareInstant(a, b) >= 0 ? a : b;
}

/** 时刻（ISO → `09-25 14:23` **本地时间**）：列宽有限，完整时刻放 title。
 *  口径与任务表的 `fmtTime` 同源 —— 两个"几点几分"长得不一样就是分叉。 */
export function fmtStamp(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 相对时间（`刚刚` / `5m` / `20h` / `3d`；一周以上退回 `MM-DD`）—— **行内紧凑时长的唯一出处**。
 *
 * 为什么：绝对时间（`10-19 18:34`）在 224px 侧栏里比标题还占地方（用户原话：「nav 上活动会话后面的
 * 日期时间太占地方了，改为 20h？」）。**它会跟着时间走** —— 靠调用方的 tick 信号重算 `nowMs`，
 * 本函数是纯函数、不自己计时（纯函数才好测，也才不会在别处偷偷起一个 interval）。
 *
 * 一周以上退回绝对日期：`20d` 这种数字已经没有信息量了。
 */
export function fmtAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const m = Math.floor(Math.max(0, nowMs - t) / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return fmtStamp(iso).slice(0, 5);
}

/** 时长（ms → `12s` / `3m05s` / `1h02m`）：界面上只读个大概，不显示毫秒 */
export function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** token 数（小数量精确、大数量 k 近似：`k/maxSteps` 那行旁边不该被 5 位数字撑破） */
export function fmtTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(1)}k`;
}

// ═══════════════════════════════════════
// 会话总览：行模型 + 切片键（##358）
// ═══════════════════════════════════════

/**
 * 账本事实的**视图输入**（结构类型 —— 与 `usageLedgerStore.TaskLedgerFacts` 同形，
 * 但本文件刻意不 import renderer store：判据层不该依赖 store，喂数据的调用方才有选择权）。
 */
export interface LedgerView {
    /** 账本里有内容 = 聊过（`.false` 只代表"读到且为空"） */
    started: boolean;
    /** 唯一 `turnId` 计数 = **跨启动的 turnCount** */
    turns: number;
    /** 累计 token（跨启动） */
    tokens: number;
    /** 累计步数（一行 = 一步，跨启动） */
    steps: number;
    /** 累计消费 $；`null` = 一条带价的都没有 */
    cost: number | null;
    /** 最后一条账的 `ts`；`null` = 账本为空 */
    lastTs: string | null;
}

/**
 * 总览一行的**状态切片键** —— 也是过滤器的取值域。
 * 一个会话任一时刻**只属于一个切片**（优先级在 `overviewRowOf` 一处定死）。
 */
export type SessionSlice = "working" | "stalled" | "error" | "unread" | "queued" | "talked";

/**
 * 会话总览的一行 —— 汇总**注册表（进程内）+ 账本（跨启动）+ 任务树（标题/项目）**三源。
 *
 * 与 `SessionRowView` 的差别：那个是「任务表里的一行」（必须有注册表条目），
 * 这个是「会话总览里的一行」（**可以只有账本历史**，entry = null）—— 用户 2026-10-17 要的
 * 「重启后总览不能是空表」。判据出自 `shared/session-state`（状态/归因/图标）+ 本文件的进度视图。
 */
export interface SessionOverviewRow {
    uri: string;
    /** 注册表条目；`null` = **本进程没活动过**（这一行整个来自账本历史） */
    entry: SessionEntry | null;
    /** 账本里有历史（跨启动） */
    talked: boolean;
    slice: SessionSlice;
    /** 图标视图（与 nav / 任务表 / 详情**同一个函数**产出的同一份） */
    glyph: SessionGlyphView;
    /** 状态短标签（`运行中 3/200` · `未读 2 条` · `已对话` …） */
    label: string;
    tip: string;
    /** 此刻有轮次在跑（注册表事实；账本-only 行恒 false） */
    running: boolean;
    /** 未读消息条数（1 轮 = 1 条，不是步数） */
    unread: number;
    /** 累计步数（注册表 ∪ 账本）；两源都无 → undefined */
    steps?: number;
    /** 累计 token（注册表 ∪ 账本）；两源都无 → undefined */
    tokens?: number;
    /** 消费 $：`null` = 账本无价 · `undefined` = 还没读到 */
    cost?: number | null;
    /** 最后活动 ISO（注册表 ∪ 账本）；两源都无 → undefined */
    lastActivity?: string;
    num?: string;
    title?: string;
    project?: string;
}

/** 两个可缺值取大（缺的一方不算）；两边都缺 → undefined。用途 = 「注册表（本进程）∪ 账本（跨启动）」 */
export function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
}

export interface OverviewRowInput {
    uri: string;
    /** 注册表条目（进程内事实）；`null` = 本进程没活动过 */
    entry: SessionEntry | null;
    /** 账本事实（跨启动）；`undefined` = 还没读到 */
    ledger: LedgerView | undefined;
    /** 已读水位（轮次）；`null` = 没有记录 */
    seenTurns: number | null;
    maxSteps: number | null;
    now: number;
    num?: string;
    title?: string;
    project?: string;
}

/**
 * 合成总览的一行；`null` = **两源都说不出话**（没聊过、也没注册表条目 → 不该出现在总览）。
 *
 * 判据不新造：状态/归因走 `sessionStateOf`（唯一真源），未读尺子 = "跨启动总轮次 − 已读水位"。
 * 两源都缺 → 不猜（返回 null，而不是编一个"空闲"）。
 */
export function overviewRowOf(i: OverviewRowInput): SessionOverviewRow | null {
    const { entry, ledger } = i;
    const talked = ledger?.started === true;
    // 两源都无话 → 不进总览（从未聊过的任务不是"会话"）
    if (!entry && !talked) return null;

    // 未读的唯一尺子 = **跨启动总轮次** = max(注册表本进程, 账本全历史) —— 见 newTurnsOf
    const totalTurns = Math.max(entry?.turnCount ?? 0, ledger?.turns ?? 0);
    const unread = i.seenTurns === null ? 0 : Math.max(0, totalTurns - i.seenTurns);
    // 0 不算事实（"读到且为 0" ≠ "累计为 0"）——与 TaskTree 的双源取大同一条规则
    const steps = maxDefined(entry && stepsNow(entry) > 0 ? stepsNow(entry) : undefined, talked ? ledger!.steps : undefined);
    const tokens = maxDefined(entry && entry.totalTokens > 0 ? entry.totalTokens : undefined, talked ? ledger!.tokens : undefined);
    const lastActivity = mergeTs(entry?.lastActivity, talked ? (ledger!.lastTs ?? undefined) : undefined);
    const cost = ledger ? ledger.cost : undefined;
    const base = {
        uri: i.uri,
        entry,
        talked,
        unread,
        steps,
        tokens,
        cost,
        lastActivity,
        num: i.num,
        title: i.title,
        project: i.project,
    };

    if (entry) {
        const state = sessionStateOf({ entry, totalTurns, unread, now: i.now });
        const glyph = glyphOf(state, i.uri);
        const running = state.run === "running";
        let slice: SessionSlice;
        if (running) slice = state.stalled ? "stalled" : "working";
        else if (state.run === "ended" && isAbnormalBlame(state.blame) && unread > 0) slice = "error";
        else if (state.queued > 0) slice = "queued";
        else if (unread > 0) slice = "unread";
        else slice = "talked";
        // 状态列的话：在跑给步数进度，其余给根因短标签（与 glyph 同源，不另编词）
        const label = running
            ? state.stalled
                ? `停滞 ${fmtDuration(idleMsOf(entry, i.now) ?? 0)}`
                : `运行中 ${stepsProgressOf(entry, i.maxSteps).text}`
            : state.run === "never"
              ? "未运行"
              : `已结束 · ${glyph.label}`;
        return {
            ...base,
            slice,
            glyph,
            label,
            tip: tipOf(entry, i.maxSteps, i.now),
            running,
        };
    }

    // 账本-only 行（本进程没活动过，纯跨启动历史）——判据同 lib/session-mark 的弱标分支
    const tip =
        `${i.uri}：账本里有历史（**跨启动**），本进程还没活动过。\n` +
        `会话共 ${totalTurns} 轮 · 累计 ${steps ?? 0} 步 · ${fmtTokens(tokens ?? 0)} tokens`;
    // 账本-only 行：状态判据同一套（有历史 + 没在跑 ⇒ ended；根因无记录 ⇒ 归因 none）
    const state = sessionStateOf({ entry: null, hasSession: true, totalTurns, unread, now: i.now });
    const glyph = glyphOf(state, i.uri);
    if (unread > 0) {
        return { ...base, slice: "unread", glyph, label: `未读 ${unread} 条`, tip, running: false };
    }
    return { ...base, slice: "talked", glyph, label: "已对话", tip, running: false };
}
