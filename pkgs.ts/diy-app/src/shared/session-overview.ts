/**
 * session-overview.ts — **全局会话可见性**（##308）的呈现判据（纯函数，renderer 与单测共用）。
 *
 * 数据源 = `agent.local.sessions`（注册表，`shared/registry-frame.ts` 的 `SessionEntry`）：
 *   一条**全局**订阅的「快照 + delta」，只搬状态（R2）。本文件把它翻成"人看的东西"：
 *   活动标记 / 步数进度 / 待投递留言 / 谁在看 / 已跑多久 / 无进展 / 异常退出。
 *
 * 【三条约束（照 ##308 的定案）】
 *   ① **主状态轴只有一条**：`working`（有轮次在跑）/ `idle`。`queue` / `viewers` / `steps` /
 *      `lastActivity` 全是**属性**，挂在同一行上，不另开状态。
 *   ② **三种「排队」必须可区分**（用户明确要的可见性）：对话中排队 / 已打开未通讯排队 /
 *      已关闭待投递 —— 判据 = `turn != null` × `viewers > 0`（`queueViewOf` 一处定义）。
 *   ③ **观测不污染（R3）**：这些函数只读注册表条目；`viewers` 是**数据**不是我们能改的东西
 *      （总览 / nav / 任务表都不许把自己算进去 —— 那由 main 侧结构性保证，见 session-registry）。
 *
 * 为什么是纯函数：三处消费者（总览页 / nav 标签 / 任务表行）必须**同一套判据**，
 * 否则"同一个会话在 nav 说在跑、在任务表说空闲"这类分叉必然发生。渲染只负责画。
 */

import { endMarkOf } from "./turn-end";
import type { SessionEntry } from "./registry-frame";

/** 主状态轴（唯一）：有轮次在跑 / 没有 */
export type SessionActivity = "working" | "idle";

export function activityOf(e: SessionEntry): SessionActivity {
    return e.turn ? "working" : "idle";
}

/**
 * 无进展阈值：在跑的轮次**这么久没有心跳**（`turn.lastOpAt` 不动）就在界面上提示"疑似卡住"。
 *
 * 它只是**提示**，不是回收判据（##305 定案：无人值守继续烧，靠 `maxSteps` 收口；真卡死由人在
 * 这里手动中断）。取值 90s：一次工具调用（含 `sleep 20` 那类）久于它也不罕见，故宁可迟钝 ——
 * 假报警会训练用户忽略这个标记。
 */
export const STALL_MS = 90_000;

/** 此刻累计步数（在跑轮次的当前步 + 本进程内已收尾轮次的累计） */
export function stepsNow(e: SessionEntry): number {
    return e.totalSteps + (e.turn?.steps ?? 0);
}

/** 在跑的轮次多久没动了（无在跑 → null） */
export function idleMsOf(e: SessionEntry, now: number): number | null {
    if (!e.turn) return null;
    const t = Date.parse(e.turn.lastOpAt);
    return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

/** 疑似卡住：在跑、且心跳超过 `STALL_MS` 没动（判据只在"有没有在跑"之上加一层，不新开状态轴） */
export function stalledOf(e: SessionEntry, now: number, thresholdMs = STALL_MS): boolean {
    const idle = idleMsOf(e, now);
    return idle !== null && idle >= thresholdMs;
}

/**
 * 「距上次看新增多少条消息」：以调用方给的**已读水位**为基线（`seenTurns`，单位 = **轮次**），
 * 算到此刻的差值。
 *
 * ⚠️ **口径订正（##358，用户拍板）**：未读 = 未读**消息**数，且 **1 个轮次 = 1 条消息** ——
 * **不是 step 数**。
 *
 * ⚠️ **总轮次必须用跨启动那把尺子**（`totalTurns`，缺省退回帧里的 `e.turnCount`）：
 * `e.turnCount` 是**本进程**计数、重启归零，而水位是**跨启动落盘**的 ⇒ 两者不同尺时
 * 未读会算错（重启后历史轮次看不见；水位写低了则点开也擦不掉，##358 微调轮 8 的 bug）。
 * 调用方（sessionStore / 任务表 / 总览）都传 `sessionStore.turnsOf(uri)`（注册表 ∪ 账本）。
 *
 * 水位是 renderer 本地量（谁在看、看到第几轮，见 sessionStore）—— 它**不回写 viewers**（R3）：
 * 这是"我读到了哪"，不是"有人在读"。
 */
export function newTurnsOf(e: SessionEntry | null, seenTurns: number | null, totalTurns?: number): number {
    if (seenTurns === null) return 0;
    // `e` 可为 null：**账本独有**的行（重启后注册表为空，但账本还记得这个任务聊过）没有注册表条目，
    // 此时总轮次只能来自 `totalTurns`（账本那把跨启动的尺子）。缺了它就把历史未读算成 0。
    return Math.max(0, (totalTurns ?? e?.turnCount ?? 0) - seenTurns);
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
 * 待投递留言（`queue`）的三档 —— **三种「排队」的唯一判据**（#308 定案②）。
 *
 *   · `chatting`    —— 打开·对话中 + queue>0（##306：本轮收尾后整批投）
 *   · `opened-idle` —— 打开·未通讯 + queue>0（页面开着，但没在跑）
 *   · `closed-idle` —— 关闭·idle + queue>0（##303 的洞：没人看它，留言躺着等下次开口）
 *
 * 判据只用 `turn` / `viewers` 两个字段 —— 不允许再按"哪个页面开着"另算（那会让同一会话
 * 在总览与 nav 上显示不同档）。
 */
export type QueueKind = "none" | "chatting" | "opened-idle" | "closed-idle";

export interface QueueView {
    kind: QueueKind;
    count: number;
    /** 短标签（chip 用）；kind="none" 时为空串 */
    label: string;
    /** 说清"这些留言什么时候会被投出去"——三档的差别正是"什么时候" */
    tip: string;
}

export function queueViewOf(e: SessionEntry): QueueView {
    const n = e.queue;
    if (n <= 0) return { kind: "none", count: 0, label: "", tip: "" };
    if (e.turn) {
        return {
            kind: "chatting",
            count: n,
            label: `排队 ${n}`,
            tip: `${n} 条留言待投递：本轮收尾后整批投给模型（##306 插话队列）`,
        };
    }
    if (e.viewers > 0) {
        return {
            kind: "opened-idle",
            count: n,
            label: `已打开·未通讯·排队 ${n}`,
            tip: `${n} 条留言待投递：会话页开着但没在跑，下一次发言开场时投`,
        };
    }
    return {
        kind: "closed-idle",
        count: n,
        label: `已关闭·待投递 ${n}`,
        tip: `${n} 条留言待投递：没有窗口在看它，留言躺在队列里，直到下次有人开口（##303）`,
    };
}

/**
 * 「非正常收尾」：最后一轮的结束原因不是 `completed`。
 *
 * 用 `endReason.type` 判（##288 的事实位），**不猜**日志。`completed` 之外都值得一眼看见：
 * 错误 / 流中断 / 用户中断 / 撞上限。
 */
export function abnormalEndOf(e: SessionEntry): boolean {
    return e.turn === null && !!e.lastEndReason && e.lastEndReason.type !== "completed";
}

/** chip 文案（nav 标签与任务表行**同一份**，宽窄由调用方截断） */
export interface SessionChipView {
    /** daisyUI 语义色（badge-<tone>） */
    tone: "primary" | "warning" | "error" | "ghost";
    icon: string;
    text: string;
    /** tooltip：把判据说全（uri / 模型 / 步数 / 留言 / 看客 / 时长 / 上次结束） */
    tip: string;
}

/**
 * 会话 chip：**一行说完**这个会话现在怎么了；`null` = 没什么可说的（调用方不渲染）。
 *
 * 刻意**不给空闲且无事的会话发 chip** —— 任务表几百行，人人都挂个"空闲"等于噪音；
 * chip 出现即"有事"（在跑 / 有留言 / 有未读新增 / 上一轮不是正常收尾）。
 *
 * ⚠️ 但「没 chip」**不等于**"不显示标记"：renderer 的 `lib/session-mark` 会在**注册表无话可说、
 * 而账本说"聊过"**时补一个弱色 `◌ 已对话`（##358，用户 2026-10-17 要的：聊过的要一直看得见，
 * 与"从未聊过"分开）。分层是刻意的 —— 本文件只认注册表（进程内事实），账本是 renderer 的合成层。
 */
export function sessionChipOf(
    e: SessionEntry,
    opts: { seenTurns: number | null; maxSteps: number | null; now: number; /** 跨启动总轮次（见 newTurnsOf） */ totalTurns?: number },
): SessionChipView | null {
    const base = tipOf(e, opts.maxSteps, opts.now);
    const q = queueViewOf(e);
    const add = newTurnsOf(e, opts.seenTurns, opts.totalTurns);

    if (e.turn) {
        const prog = stepsProgressOf(e, opts.maxSteps);
        const stalled = stalledOf(e, opts.now);
        const bits: string[] = [prog.text];
        if (stalled) bits.push(`停滞 ${fmtDuration(idleMsOf(e, opts.now) ?? 0)}`);
        if (q.kind !== "none") bits.push(q.label);
        if (e.viewers === 0) bits.push("无人看");
        if (add > 0) bits.push(`+${add}`);
        return {
            tone: stalled ? "warning" : "primary",
            icon: "●",
            text: bits.join(" · "),
            tip: base,
        };
    }

    // 空闲：留言 / 异常收尾 / 未读新增，按"用户更该知道"排先后
    if (q.kind !== "none") {
        return { tone: "warning", icon: "⏸", text: q.label, tip: base };
    }
    if (abnormalEndOf(e)) {
        const mark = endMarkOf(e.lastEndReason, false);
        return {
            tone: mark.tone === "err" ? "error" : "warning",
            icon: mark.icon,
            text: mark.tip,
            tip: base,
        };
    }
    // 未读 = **绿 `+N`**（N = 未读消息条数；##358 口径订正：1 轮 = 1 条，不是步数）
    if (add > 0) {
        return { tone: "primary", icon: "", text: `+${add}`, tip: base };
    }
    return null;
}

/**
 * 「该不该先看」的位次（**越小越该看**）——排序与分组用同一把尺子。
 * 运行中 > 异常终止未读 > 未读 > 待投递留言 > 已对话（无话可说）。
 */
export type SessionAttention = 0 | 1 | 2 | 3 | 4;

/**
 * 会话在**有空间的地方**（任务管理表）该说什么：比 chip 多给「状态位次 + token + 最后活动」，
 * 因为任务表空间大，不必像 nav 那样一个字一个字省。
 *
 * 判据与 chip **同源**（都在本文件），只是呈现粒度不同 —— 别在这里另起一套状态判断。
 */
export interface SessionRowView {
    /** 状态位次（排序用；越小越该看） */
    attention: SessionAttention;
    /** 状态短标签（运行中 / 异常终止 / 未读 / 待投递 / 已对话） */
    state: string;
    /** 配色（与 chip 同色义：绿=运行/未读、红=异常、黄=停滞/留言） */
    tone: SessionChipView["tone"];
    icon: string;
    /** 未读消息条数（##358：1 轮 = 1 条，不是步数；0 = 没有未读） */
    unread: number;
    /** 本进程内累计 token */
    tokens: number;
    /** 最后一次活动时刻（ISO） */
    lastActivity: string;
}

/**
 * 会话在任务表里的「一行信息」（判据与 chip / 总览同源，粒度更粗但结论必须一致）。
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
    const stalled = stalledOf(e, now);
    const q = queueViewOf(e);
    const base = { unread, tokens: e.totalTokens, lastActivity: e.lastActivity };

    if (e.turn) {
        const prog = stepsProgressOf(e, maxSteps);
        return {
            ...base,
            attention: 0,
            state: stalled ? `停滞 ${fmtDuration(idleMsOf(e, now) ?? 0)}` : `运行中 ${prog.text}`,
            tone: stalled ? "warning" : "primary",
            icon: "●",
        };
    }
    if (abnormalEndOf(e)) {
        const mark = endMarkOf(e.lastEndReason, false);
        // 异常终止**且未读** → 红（用户原话：红色 = 未读异常终止）；已读的异常仍是黄
        return {
            ...base,
            attention: unread > 0 ? 1 : 4,
            state: mark.tip,
            tone: unread > 0 ? "error" : "warning",
            icon: mark.icon,
        };
    }
    if (q.kind !== "none") {
        return { ...base, attention: 3, state: q.label, tone: "warning", icon: "⏸" };
    }
    if (unread > 0) {
        return { ...base, attention: 2, state: `未读 ${unread} 条`, tone: "primary", icon: "" };
    }
    // 无事可报 ≠ 从没聊过：这里给**弱标「已对话」**（与 lib/session-mark 的 chip 用同一个词）。
    // 一个词只能有一个意思 —— nav 说「已对话」而任务表说「空闲」就是同一类分叉。
    return { ...base, attention: 4, state: "已对话", tone: "ghost", icon: "◌" };
}

/** chip / 行的公用 tooltip：把这条会话的判据一次说全 */
export function tipOf(e: SessionEntry, maxSteps: number | null, now: number): string {
    const uri = e.refs.find((r) => r.kind === "task")?.uri ?? e.id;
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
    return a > b ? a : b;
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
 * 「重启后总览不能是空表」。判据仍出自本文件的同一批函数（chip / 未读 / 进度）。
 */
export interface SessionOverviewRow {
    uri: string;
    /** 注册表条目；`null` = **本进程没活动过**（这一行整个来自账本历史） */
    entry: SessionEntry | null;
    /** 账本里有历史（跨启动） */
    talked: boolean;
    slice: SessionSlice;
    tone: SessionChipView["tone"];
    icon: string;
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
 * 判据不新造：注册表侧逐条走 `sessionChipOf / stalledOf / queueViewOf / abnormalEndOf`，
 * 账本侧走"跨启动轮次 − 已读水位"（与 `lib/session-mark` 的 chip 同一口径）。
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
        const chip = sessionChipOf(entry, {
            seenTurns: i.seenTurns,
            maxSteps: i.maxSteps,
            now: i.now,
            totalTurns,
        });
        const running = entry.turn !== null;
        const stalled = stalledOf(entry, i.now);
        const q = queueViewOf(entry);
        let slice: SessionSlice;
        if (running) slice = stalled ? "stalled" : "working";
        else if (abnormalEndOf(entry) && unread > 0) slice = "error";
        else if (q.kind !== "none") slice = "queued";
        else if (unread > 0) slice = "unread";
        else slice = "talked";
        return {
            ...base,
            slice,
            // 注册表无话可说（聊过但没事）→ 弱标「已对话」，与任务表 / 详情任务树**同一个词**
            tone: chip?.tone ?? "ghost",
            icon: chip?.icon ?? "◌",
            label: chip?.text ?? "已对话",
            tip: tipOf(entry, i.maxSteps, i.now),
            running,
        };
    }

    // 账本-only 行（本进程没活动过，纯跨启动历史）——判据同 lib/session-mark 的弱标分支
    const tip =
        `${i.uri}：账本里有历史（**跨启动**），本进程还没活动过。\n` +
        `会话共 ${totalTurns} 轮 · 累计 ${steps ?? 0} 步 · ${fmtTokens(tokens ?? 0)} tokens`;
    if (unread > 0) {
        return { ...base, slice: "unread", tone: "primary", icon: "", label: `+${unread}`, tip, running: false };
    }
    return { ...base, slice: "talked", tone: "ghost", icon: "◌", label: "已对话", tip, running: false };
}
