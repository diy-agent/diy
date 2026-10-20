/**
 * session-nav.ts — **nav 侧的会话活动语汇**（##358 D1/D2 → ##393 收编，纯函数，renderer 与单测共用）。
 *
 * 用户原话（##180，2026-10-16）：
 *   「更紧凑的 nav 提示形式，比如 `+23` 表示未读进度，**绿色是未读，红色是未读异常终止，
 *     闪烁的绿色是运行中**，其他你想想，如何让用户快速了解自己在干啥」
 *
 * 【##393 收编后的分工（判据不再有第二份）】
 *   状态 / 归因 / 图标语言全部在 `shared/session-state`（`sessionStateOf` / `glyphOf`）；
 *   本文件只做**多行 → 一个角标的聚合与排序**（nav 那 40px 收起态装不下第二个角标）。
 *   改造前本文件自带一张 `VISUAL` 配色表 + 一套优先级判据 —— 那是用户 3.3「四处不一致」的
 *   来源之一，已删除。
 *
 * 【两条定案】
 *   ① **同一时刻只出一个「主角标」**：优先级 = 停滞 > 运行中 > 异常未读 > 未读 > 队列
 *      （停滞是运行的**子集/健康度**，不是第四种状态 —— 用户 2026-10-20 口径）。
 *   ② **关掉 ≠ 消失**：没开着 tab、但有活态的会话进「后台活动」区（`backgroundOf`）。
 */

import type { SessionEntry } from "./registry-frame";
import {
    glyphOf,
    isAbnormalBlame,
    newTurnsOf,
    queueViewOf,
    sessionStateOf,
    stalledOf,
    type GlyphTone,
    type SessionState,
} from "./session-state";

/** 一行会话在 nav 视角下的**位次**（判据来自 session-state，本文件只聚合） */
export interface NavRow {
    uri: string;
    /** 人类可读名（调用方解析 `#num 标题` —— 纯函数不碰任务树） */
    label: string;
    /** 会话状态（唯一真值；下面几个布尔只是它的便捷投影，别当第二份判据用） */
    state: SessionState;
    /** 此刻有轮次在跑（注册表事实；##305：没人看也在跑） */
    running: boolean;
    /** 在跑、但心跳超过 `STALL_MS` 没动（##308 的"疑似卡住"，**运行健康度**） */
    stalled: boolean;
    /** 上一轮归因是"值得看一眼"（limit / service / environment / unknown / defect）；
     *  `none`（正常结束）与 `user`（你自己按的停止）都不算 */
    abnormal: boolean;
    /** 未读**消息**条数（1 轮 = 1 条，不是步数；##358 口径订正） */
    unread: number;
    /** 待投递留言条数（##306） */
    queue: number;
    /** 这个窗口开着它的 tab（开着 = 已在视线内，不必再提示） */
    opened: boolean;
    /** 最后活动时刻（ISO）—— **跨启动**那一把尺子（账本最后一条账的 `ts`） */
    lastTs: string | null;
}

export interface NavRowInput {
    uri: string;
    label: string;
    opened: boolean;
    /** 注册表条目；**`null` = 注册表里没有**（账本独有：重启后仍然"聊过但没在跑"） */
    entry: SessionEntry | null;
    /** 账本最后活动时刻（跨启动）；用在 `NavRow.lastTs` */
    lastTs?: string | null;
    /** 已读水位（轮次） */
    seenTurns: number | null;
    /** 跨启动总轮次（注册表 ∪ 账本）；缺了未读会用错尺子 */
    totalTurns?: number;
    /** 聊过没有（落盘快照 / 账本）；缺省按注册表推 */
    hasSession?: boolean;
    /** 有未发送草稿（属性，不影响状态轴） */
    hasDraft?: boolean;
    maxSteps: number | null;
    now: number;
}

/**
 * **nav 行集** = 任务树里的全部任务 ∪ 注册表里的全部会话（用户 2：「运行中的会话立即放到 nav，
 * 哪怕原来并未在导航上，作为有一种激活的概念」）。
 *
 * 为什么是纯函数、为什么钉单测：这条是**语义**（在跑就够得着），不是一次手工测量。
 *   · 判据 = **注册表 `running`**，**不看 `opened`** —— 没打开过、窗口都没开，也得在行集里（##305）；
 *   · 顺带兜住「任务树里没有」的会话（任务已删 / 换项目）：注册表有就是事实，不因查不到标题而丢行；
 *   · 任务树在前（稳定序，nav 排序另由 `rankOf` 决定），注册表新增按出现序追加。
 */
export function navUrisOf(taskUris: readonly string[], registryUris: readonly string[]): string[] {
    const us = new Set<string>(taskUris);
    for (const uri of registryUris) us.add(uri);
    return [...us];
}

/** 注册表条目 → nav 行（状态判据全走 session-state，一处定义） */
export function navRowOf(i: NavRowInput): NavRow {
    const e = i.entry;
    const unread = newTurnsOf(e, i.seenTurns, i.totalTurns);
    const state = sessionStateOf({
        entry: e,
        hasSession: i.hasSession,
        totalTurns: i.totalTurns,
        hasDraft: i.hasDraft,
        unread,
        now: i.now,
    });
    return {
        uri: i.uri,
        label: i.label,
        state,
        running: state.run === "running",
        stalled: state.stalled,
        abnormal: state.run === "ended" && isAbnormalBlame(state.blame),
        unread: state.unread,
        queue: state.queued,
        opened: i.opened,
        lastTs: i.lastTs ?? null,
    };
}

/** 角标的**判据档**（与配色分开：同一档未来换色不该改判据，反之亦然） */
export type NavBadgeKey = "stalled" | "running" | "error" | "unread" | "queue";

export interface NavBadge {
    key: NavBadgeKey;
    /** 颜色 = 归因（唯一表在 session-state::TONE_OF_BLAME） */
    tone: GlyphTone;
    /** 该不该**呼吸**（用户原话：闪烁的绿色 = 运行中） */
    pulse: boolean;
    /** 展开态文案 */
    text: string;
    /** 收起态文案（40px rail 只装得下 1~3 个字符） */
    short: string;
    /** tooltip：把"为什么亮"和一个都不许漏的会话名列出来 */
    tip: string;
}

/** 未读角标文案：统一 `+n`（收起态也够装；超大值截断，别把 rail 撑破） */
export function unreadText(n: number): string {
    return `+${n > 99 ? "99+" : n}`;
}

/** 一个 URI 列表 → tooltip 用的一行（最多 4 条，其余折成"等 N 个"） */
function namesOf(rows: NavRow[], limit = 4): string {
    const head = rows.slice(0, limit).map((r) => r.label || r.uri);
    const rest = rows.length - head.length;
    return head.join("、") + (rest > 0 ? ` 等 ${rows.length} 个` : "");
}

/**
 * **主角标**：nav 上那一个"现在最该被看见"的角标；`null` = 无事发生。
 *
 * 优先级 = **停滞 > 运行中 > 异常未读 > 未读 > 队列**（停滞是运行档内的健康度，不单开一档）。
 * 同档多个会话 → **聚合**（`+7` = 一共 7 条未读）。
 */
export function heroBadgeOf(rows: NavRow[]): NavBadge | null {
    const running = rows.filter((r) => r.running);
    if (running.length > 0) {
        const stalled = running.filter((r) => r.stalled);
        if (stalled.length > 0) {
            return {
                key: "stalled",
                tone: "amber",
                pulse: false,
                text: `${stalled.length} 个会话停滞`,
                short: "⚠",
                tip:
                    `**${stalled.length} 个会话在跑但长时间没动静**（#308 无进展判据）：\n${namesOf(stalled)}\n` +
                    `它只是**提示**、不是回收判据 —— 真卡死由你手动中断（##305）。`,
            };
        }
        return {
            key: "running",
            tone: "green",
            pulse: true,
            text: running.length > 1 ? `运行中 ${running.length}` : "运行中",
            short: "●",
            tip: `**${running.length} 个会话正在跑**（没开窗口也在跑，##305）：\n${namesOf(running)}`,
        };
    }

    const err = rows.filter((r) => r.abnormal && r.unread > 0);
    if (err.length > 0) {
        const n = err.reduce((s, r) => s + r.unread, 0);
        // 颜色跟着**归因**走（unknown 紫 / service 橙 / limit 琥珀），不再一律红 ——
        // 用户 2026-10-20：异常种类很多，红色只留给"我方缺陷"
        const worst = err.find((r) => r.state.blame === "defect") ?? err.find((r) => r.state.blame === "unknown") ?? err[0];
        return {
            key: "error",
            tone: glyphOf(worst.state).tone,
            pulse: false,
            text: unreadText(n),
            short: unreadText(n),
            tip:
                `**${unreadText(n)} 条未读，且上一轮不是预期内收尾**（${err.map((r) => glyphOf(r.state).label).join("、")}）：\n` +
                `${namesOf(err)}\n这是唯一会**自动拉回**视线的一种（##358 D3）。`,
        };
    }

    const unread = rows.filter((r) => r.unread > 0);
    if (unread.length > 0) {
        const n = unread.reduce((s, r) => s + r.unread, 0);
        return {
            key: "unread",
            tone: "green",
            pulse: false,
            text: unreadText(n),
            short: unreadText(n),
            tip: `**${unreadText(n)} 条未读消息**（1 轮 = 1 条，不是步数）：\n${namesOf(unread)}\n想看不看随你。`,
        };
    }

    const queued = rows.filter((r) => r.queue > 0);
    if (queued.length > 0) {
        const n = queued.reduce((s, r) => s + r.queue, 0);
        return {
            key: "queue",
            tone: "violet",
            pulse: false,
            text: `队列 ${n}`,
            short: String(n),
            tip:
                `**${n} 条留言待投递**（##306 插话队列）：\n${namesOf(queued)}\n` +
                `它们在等"下一次开口"才会被投出去 —— 没别的主角标时它才占位。`,
        };
    }
    return null;
}

/** **次角标**：主角标之外那一件"也想让你知道"的事（现在只有队列，紫）。 */
export function secondaryBadgeOf(rows: NavRow[], hero: NavBadge | null): NavBadge | null {
    if (hero?.key === "queue") return null;
    const queued = rows.filter((r) => r.queue > 0);
    if (queued.length === 0) return null;
    const n = queued.reduce((s, r) => s + r.queue, 0);
    return {
        key: "queue",
        tone: "violet",
        pulse: false,
        text: String(n),
        short: String(n),
        tip: `另有 **${n} 条留言待投递**（##306）：\n${namesOf(queued)}`,
    };
}

/** 单行的角标（「会话」区每行用；判据与 `heroBadgeOf` 同源，只是不做聚合） */
export function rowBadgeOf(r: NavRow): NavBadge | null {
    const g = glyphOf(r.state, r.label);
    if (r.stalled)
        return { key: "stalled", tone: "amber", pulse: false, text: "停滞", short: "⚠", tip: `${r.label}：在跑但长时间没动静` };
    if (r.running)
        return { key: "running", tone: "green", pulse: true, text: "运行中", short: "●", tip: `${r.label}：正在跑（##305 无窗口也在跑）` };
    if (r.abnormal && r.unread > 0)
        return {
            key: "error",
            tone: g.tone,
            pulse: false,
            text: unreadText(r.unread),
            short: unreadText(r.unread),
            tip: `${r.label}：上一轮 ${g.label}，且未读`,
        };
    if (r.unread > 0)
        return {
            key: "unread",
            tone: "green",
            pulse: false,
            text: unreadText(r.unread),
            short: unreadText(r.unread),
            tip: `${r.label}：未读 ${r.unread} 条消息`,
        };
    if (r.queue > 0)
        return { key: "queue", tone: "violet", pulse: false, text: `队列 ${r.queue}`, short: String(r.queue), tip: `${r.label}：${r.queue} 条留言待投递` };
    return null;
}

/** 排序位次（越小越该看）——「会话」区的行序 */
export function rankOf(r: NavRow): number {
    if (r.stalled) return 0;
    if (r.running) return 1;
    if (r.abnormal && r.unread > 0) return 2;
    if (r.unread > 0) return 3;
    return 4;
}

/** 「**后台活动**」区的行 = **没开着 tab、但有活态**的会话（关掉 ≠ 消失） */
export function backgroundOf(rows: NavRow[]): NavRow[] {
    return rows
        .filter((r) => !r.opened && (r.running || r.unread > 0 || r.queue > 0))
        .slice()
        .sort((a, b) => rankOf(a) - rankOf(b) || b.unread - a.unread || a.uri.localeCompare(b.uri));
}

/** 「需要你看」的会话（异常未读 / 停滞 / 留言在等，且没开着） */
export function needsYouOf(rows: NavRow[]): NavRow[] {
    return backgroundOf(rows).filter((r) => (r.abnormal && r.unread > 0) || r.stalled || r.queue > 0);
}

/** 会话是否"有活态"（用来决定 nav 行要不要出现在「会话」列表里） */
export function aliveOf(r: NavRow): boolean {
    return r.running || r.unread > 0 || r.queue > 0 || (r.abnormal && r.unread > 0);
}

// 保留导出：`queueViewOf` / `stalledOf` 曾是本文件的判据来源，现在真源在 session-state，
// 这里只做**转发**（老调用点不必改 import 路径，且不会有人误以为还有第二份实现）。
export { queueViewOf, stalledOf };
