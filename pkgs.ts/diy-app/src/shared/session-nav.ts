/**
 * session-nav.ts — **nav 侧的会话活动语汇**（##358 D1/D2，纯函数，renderer 与单测共用）。
 *
 * 用户原话（##180，2026-10-16）：
 *   「更紧凑的 nav 提示形式，比如 `+23` 表示未读进度，**绿色是未读，红色是未读异常终止，
 *     闪烁的绿色是运行中**，其他你想想，如何让用户快速了解自己在干啥」
 *   「session 正在跑 / 结果没看，但被我从 nav 关了 → 如何**提示并回到视线**」
 *
 * 【两条定案（本文件就是它们的落点）】
 *   ① **同一时刻只出一个「主角标」**：nav 那 40px 收起态装不下第二个角标；
 *      优先级 = 停滞 > 运行中 > 异常未读 > 未读 > 队列（见 `heroBadgeOf` 的注释：停滞是运行的子集）。
 *      其余信息不丢，降级成**次角标**（队列，见 `secondaryBadgeOf`）与 **tooltip**。
 *   ② **关掉 ≠ 消失**：没开着 tab、但有活态的会话进「**后台活动**」区（`backgroundOf`），
 *      于是「我关了它，它在后台跑完了」这件事仍然看得见。
 *
 * 【判据不新造】每个位次都出自 `shared/session-overview`（`stalledOf` / `abnormalEndOf` /
 *   `queueViewOf` / `newTurnsOf`）—— nav 与任务表、总览页看的是**同一套结论**，
 *   只是呈现粒度不同（nav 只有一个小角标）。本文件只做「多行 → 一个角标」的聚合与排序。
 *
 * 为什么是纯函数：角标是"看一眼就知道该不该点进去"的东西，判据错了就是**训练用户忽略它**。
 * 抽出来可单测（`tests/core/session-nav.test.ts`），不必靠截图。
 */

import { abnormalEndOf, newTurnsOf, queueViewOf, stalledOf } from "./session-overview";
import type { SessionEntry } from "./registry-frame";

/** 一行会话在 nav 视角下的**位次**（判据来自 session-overview，本文件只聚合） */
export interface NavRow {
    uri: string;
    /** 人类可读名（调用方解析 `#num 标题` —— 纯函数不碰任务树） */
    label: string;
    /** 此刻有轮次在跑（注册表事实；##305：没人看也在跑） */
    running: boolean;
    /** 在跑、但心跳超过 `STALL_MS` 没动（##308 的"疑似卡住"） */
    stalled: boolean;
    /** 上一轮**不是**正常收尾（error / 中断 / 撞上限） */
    abnormal: boolean;
    /** 未读**消息**条数（1 轮 = 1 条，不是步数；##358 口径订正） */
    unread: number;
    /** 待投递留言条数（##306） */
    queue: number;
    /** 这个窗口开着它的 tab（开着 = 已在视线内，不必再提示） */
    opened: boolean;
    /**
     * 最后活动时刻（ISO）—— **跨启动**那一把尺子（账本最后一条账的 `ts`）。
     * 用途 = 「待你处理」区每行都给个时间：不点进去就知道"这是什么时候的事"。
     * `null` = 账本里没有（没聊过 / 还没读到）。
     */
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
    maxSteps: number | null;
    now: number;
}

/** 注册表条目 → nav 行（判据全走 session-overview，一处定义） */
export function navRowOf(i: NavRowInput): NavRow {
    const e = i.entry;
    return {
        uri: i.uri,
        label: i.label,
        running: !!e && e.turn !== null,
        stalled: !!e && stalledOf(e, i.now),
        abnormal: !!e && abnormalEndOf(e),
        unread: newTurnsOf(e, i.seenTurns, i.totalTurns),
        queue: e ? queueViewOf(e).count : 0,
        opened: i.opened,
        lastTs: i.lastTs ?? null,
    };
}

/** 角标配色（**按颜色说话**：用户给的就是颜色词 —— 绿=未读/运行，红=未读异常，黄=停滞，紫=队列） */
export type NavTone = "green" | "amber" | "red" | "purple";

/** 角标的**判据档**（与配色分开：同一档未来换色不该改判据，反之亦然） */
export type NavBadgeKey = "stalled" | "running" | "error" | "unread" | "queue";

export interface NavBadge {
    key: NavBadgeKey;
    tone: NavTone;
    /** 该不该**闪**（用户原话：闪烁的绿色 = 运行中） */
    pulse: boolean;
    /** 展开态文案 */
    text: string;
    /** 收起态文案（40px rail 只装得下 1~3 个字符） */
    short: string;
    /** tooltip：把"为什么亮"和一个都不许漏的会话名列出来 */
    tip: string;
}

interface ToneOfKey {
    tone: NavTone;
    pulse: boolean;
}

const VISUAL: Record<NavBadgeKey, ToneOfKey> = {
    stalled: { tone: "amber", pulse: false },
    running: { tone: "green", pulse: true },
    error: { tone: "red", pulse: false },
    unread: { tone: "green", pulse: false },
    queue: { tone: "purple", pulse: false },
};

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

function badge(key: NavBadgeKey, text: string, short: string, tip: string): NavBadge {
    return { key, tone: VISUAL[key].tone, pulse: VISUAL[key].pulse, text, short, tip };
}

/**
 * **主角标**：nav 上那一个"现在最该被看见"的角标；`null` = 无事发生（不渲染 —— 别给空闲发角标，
 * 满屏角标等于没有角标）。
 *
 * 优先级= **停滞 > 运行中 > 异常未读 > 未读 > 队列**。
 * 为什么停滞排在运行之前：**停滞是运行的子集**（`stalled ⇒ running`），一个"在跑但 90s 没动静"的
 * 会话比一个"正在正常吐字"的会话更该被看见；用户给的颜色词也分了两色（黄 ⚠ / 绿 ●）。
 * 这条不违反用户写的「运行 > 未读 > 队列」——它管的是**跨档**顺序，停滞仍在"运行"这一档内。
 *
 * 同档多个会话 → **聚合**（`+7` = 一共 7 条未读，而不是"某一个会话的 7 条"），
 * 具体是谁进 tooltip 与「后台活动」区（nav 装不下名字，硬塞只会变成噪音）。
 */
export function heroBadgeOf(rows: NavRow[], opts: { collapsed: boolean }): NavBadge | null {
    const running = rows.filter((r) => r.running);
    if (running.length > 0) {
        const stalled = running.filter((r) => r.stalled);
        if (stalled.length > 0) {
            return badge(
                "stalled",
                `${stalled.length} 个会话停滞`,
                "⚠",
                `**${stalled.length} 个会话在跑但长时间没动静**（#308 无进展判据）：\n${namesOf(stalled)}\n` +
                    `它只是**提示**、不是回收判据 —— 真卡死由你手动中断（##305）。`,
            );
        }
        return badge(
            "running",
            running.length > 1 ? `运行中 ${running.length}` : "运行中",
            "●",
            `**${running.length} 个会话正在跑**（没开窗口也在跑，##305）：\n${namesOf(running)}`,
        );
    }

    const err = rows.filter((r) => r.abnormal && r.unread > 0);
    if (err.length > 0) {
        const n = err.reduce((s, r) => s + r.unread, 0);
        return badge(
            "error",
            unreadText(n),
            unreadText(n),
            `**${unreadText(n)} 条未读，且上一轮是异常收尾**（错误 / 中断 / 撞上限）：\n${namesOf(err)}\n` +
                `这是唯一会**自动拉回**视线的一种（##358 D3）。`,
        );
    }

    const unread = rows.filter((r) => r.unread > 0);
    if (unread.length > 0) {
        const n = unread.reduce((s, r) => s + r.unread, 0);
        return badge(
            "unread",
            unreadText(n),
            unreadText(n),
            `**${unreadText(n)} 条未读消息**（1 轮 = 1 条，不是步数）：\n${namesOf(unread)}\n想看不看随你。`,
        );
    }

    const queued = rows.filter((r) => r.queue > 0);
    if (queued.length > 0) {
        const n = queued.reduce((s, r) => s + r.queue, 0);
        return badge(
            "queue",
            `队列 ${n}`,
            String(n),
            `**${n} 条留言待投递**（##306 插话队列）：\n${namesOf(queued)}\n` +
                `它们在等"下一次开口"才会被投出去 —— 没别的主角标时它才占位。`,
        );
    }
    return null;
}

/**
 * **次角标**：主角标之外那一件"也想让你知道、但不值得换掉主角标"的事。
 *
 * 现在只有队列（紫）：有未读 / 有会话在跑时，队列不抢主角位，但得留个痕迹
 * （demo 的口径：`queue` 只在"没别的主角标"时才当主角）。主角标本身就是队列 → 返回 null（不重复）。
 */
export function secondaryBadgeOf(rows: NavRow[], hero: NavBadge | null): NavBadge | null {
    if (hero?.key === "queue") return null;
    const queued = rows.filter((r) => r.queue > 0);
    if (queued.length === 0) return null;
    const n = queued.reduce((s, r) => s + r.queue, 0);
    return badge("queue", String(n), String(n), `另有 **${n} 条留言待投递**（##306）：\n${namesOf(queued)}`);
}

/**
 * 单行的角标（「后台活动」区每行用；判据与 `heroBadgeOf` 同源，只是不做聚合 —— 行本身就是"一个会话"）。
 * 展开/收起由调用方选 `text` / `short`（同一份判据不该因为宽度不同而分叉）。
 */
export function rowBadgeOf(r: NavRow): NavBadge | null {
    if (r.stalled) return badge("stalled", "停滞", "⚠", `${r.label}：在跑但长时间没动静`);
    if (r.running) return badge("running", "运行中", "●", `${r.label}：正在跑（##305 无窗口也在跑）`);
    if (r.abnormal && r.unread > 0) {
        return badge("error", unreadText(r.unread), unreadText(r.unread), `${r.label}：上一轮异常收尾，且未读`);
    }
    if (r.unread > 0) {
        return badge("unread", unreadText(r.unread), unreadText(r.unread), `${r.label}：未读 ${r.unread} 条消息`);
    }
    if (r.queue > 0) return badge("queue", `队列 ${r.queue}`, String(r.queue), `${r.label}：${r.queue} 条留言待投递`);
    return null;
}

/** 排序位次（越小越该看）——「后台活动」区的行序 */
export function rankOf(r: NavRow): number {
    if (r.stalled) return 0;
    if (r.running) return 1;
    if (r.abnormal && r.unread > 0) return 2;
    if (r.unread > 0) return 3;
    return 4;
}

/**
 * 「**后台活动**」区的行 = **没开着 tab、但有活态**的会话（用户原话：从 nav 关掉，但它还在跑 / 跑完了没看）。
 *
 * 判据刻意**不记"谁关过什么"**（那要一份 renderer 私有台账，且重启就丢）：直接问"它现在有没有事"
 * —— 关掉一个已经在跑的会话，它就落进这里；重开 tab，它自动离开（`opened`）。
 * 数据源 = 注册表（进程内事实），**跨启动的历史归 D4「继续工作」**（那个才需要账本）。
 */
export function backgroundOf(rows: NavRow[]): NavRow[] {
    return rows
        .filter((r) => !r.opened && (r.running || r.unread > 0 || r.queue > 0))
        .slice()
        .sort((a, b) => rankOf(a) - rankOf(b) || b.unread - a.unread || a.uri.localeCompare(b.uri));
}

/** 「需要你看」的会话（异常未读 / 停滞 / 留言在等，且没开着）—— D3 的三级提示与 D5 的输入 */
export function needsYouOf(rows: NavRow[]): NavRow[] {
    return backgroundOf(rows).filter((r) => (r.abnormal && r.unread > 0) || r.stalled || r.queue > 0);
}
