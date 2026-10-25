/**
 * session-alerts.ts — **三级提示的"什么时候该打断你"**（##358 D3，纯函数，renderer 与单测共用）。
 *
 * 用户原话（##180，2026-10-16）：
 *   「考虑如果一个 session 虽然正在运行、或运行结果还没看，但是被我从 nav 导航关了，
 *     如何**提示并回到视线，或自动回到 nav**？」
 * 规格真源 = demo v4 的「② 被关掉的会话 → 回到视线（三级，按『值不值得打断』分）」：
 *   - **L0 常驻角标（不打断）** —— 任何未读 / 在跑都有标记（= nav 主角标 / 「后台活动」区，见 `session-nav`）
 *   - **L1 一次性 toast（提示，不抢焦点）** —— 后台**跑完**、**无进展**、**异常终止**各弹一次，带 `[回到]`
 *   - **L2 自动拉回（抢焦点，仅两种）** —— 只有 **异常终止** 与 **有人（人！）在等你回复**（##435：
 *     队列里有**人署名**的留言；job 结束通知 / 别的 agent 派的活也走同一队列，但它们不需要人动手）
 *
 * 【本文件唯一的判据：只报"跃迁"，不报"现在是什么"】
 *   「现在有 3 个未读」不是事件 —— 它是**状态**，已经由角标 / 后台活动区负责（L0）。
 *   若拿状态当事件，后果有两个，且都会**训练用户忽略角标**：
 *     ① app 一启动，历史未读全部弹一遍（用户刚开 app 就被 10 条 toast 糊脸）；
 *     ② 每 tick 重算（停滞判据依赖"现在几点"）→ 同一条未读**反复弹**。
 *   ⇒ `alertsOf(prev, next)` 拿**两次快照**比，只对"这一次变了"的会话出提示。
 *   `prev` 里没有的 uri = **基线**（第一次见到它只记状态，不报事件）；`opened` = 已在视线内，不打断。
 *
 * 为什么是纯函数：这条判据错了会**半夜抢焦点**（L2 自动开 tab）或**永远不提示**（漏报），
 * 两者都不是样式问题。抽出来可单测（`tests/core/session-alerts.test.ts`），不必靠守着屏幕。
 */

import type { NavRow } from "./session-nav";

/** 一次性提示（toast）的事件种类。**只列"跃迁"，不列"状态"** */
export type AlertKind =
    /** 在跑的轮次收尾了、且是**正常**收尾、且有未读 */
    | "finished"
    /** 在跑但长时间没动静（##308 停滞判据），刚进这个状态 */
    | "stalled"
    /** 上一轮**异常**收尾（错误 / 中断 / 撞上限）且有未读 */
    | "failed"
    /** 队列里刚出现**人署名**的留言（有人在等你回复，##306 插话队列） */
    | "waiting"
    /**
     * 队列里刚出现**全部非人**的留言（job 结束通知 / 别的 agent 派活 / 无署名，##435）。
     *
     * 为什么单列一种而不是并入 waiting：queue 的收件人是 **agent**，不是人 ——
     * 这些条投递后由 agent 自己消化，人类零动作（##435 现场：11 条队列 0 条来自人，
     * L2 抢焦点 100% 是噪音）。故它只能 L1：提示一句、不抢焦点、不开 tab。
     */
    | "queued-auto";

export interface SessionAlert {
    /** 去重键 = `uri|kind`（同一会话同一事件只该弹一次） */
    key: string;
    uri: string;
    label: string;
    kind: AlertKind;
    /** L1 = toast 提示（不抢焦点）· L2 = 自动拉回（抢焦点） */
    level: "L1" | "L2";
    /** 该不该**自动开 tab**：`level === "L2"` 且用户没关掉那个开关 */
    autoPull: boolean;
    text: string;
    /**
     * 触发时队列里的**人署名**条数（其它 kind 恒 0）。
     *
     * 给提示搬二级信息（`addToast` 的 reason 要写「条数 + author 分布」）用：
     * 只靠文案里的总数分不出「谁在等」，详情面板就又要靠猜了（##391 / ##435）。
     */
    queueHuman: number;
    /** 触发时队列里的**非人**条数（job / agent / 无署名） */
    queueAuto: number;
}

/** 事件文案里统一用的动作按钮（L1 的 `[回到]`） */
export const ALERT_ACTION_LABEL = "回到";

/** 「人署名留言」那档专用的动作按钮：说的是「看留言」，而不只是「回到这个会话」 */
export const ALERT_QUEUE_ACTION_LABEL = "看留言";

/**
 * 快照比较 → 该弹的提示（**按优先级每会话至多一条**）。
 *
 * 一个会话同时满足两条（如"异常终止"且"队列里有留言"）时只出最重的一条 ——
 * toast 是打断，一次打断说两件事等于没说。优先级：异常终止 > 有人在等 > 无进展 > 跑完（含自动留言）。
 *
 * @param prev 上一次快照（`uri → NavRow`）；空对象 = **首次建基线**，此时一律不报（见头注 ①）
 * @param next 这一次快照
 * @param opts.autoPull 用户的「自动拉回」开关（缺省开）；关掉只降级为 L1 toast，**不丢提示**
 */
export function alertsOf(
    prev: Record<string, NavRow>,
    next: NavRow[],
    opts: { autoPull: boolean },
): SessionAlert[] {
    const out: SessionAlert[] = [];
    for (const r of next) {
        const p = prev[r.uri];
        if (!p) continue; // 基线：第一次见到它 = 记状态，不报事件
        if (r.opened) continue; // 已在视线内（tab 开着）⇒ 提示是纯噪音

        const item = pick(r, p);
        if (!item) continue;
        const autoPull = item.level === "L2" && opts.autoPull;
        // 只在"队列"两种 kind 上报来源分布（其它 kind 的 queueHuman 字段无意义）
        const viaQueue = item.kind === "waiting" || item.kind === "queued-auto";
        const queueHuman = viaQueue ? Math.max(0, Math.min(r.queueHuman, r.queue)) : 0;
        out.push({
            key: `${r.uri}|${item.kind}`,
            uri: r.uri,
            label: r.label,
            kind: item.kind,
            level: item.level,
            autoPull,
            text: item.text + (item.level === "L2" ? (autoPull ? " —— 已自动拉回视线。" : "（自动拉回已关）") : ""),
            queueHuman,
            queueAuto: viaQueue ? Math.max(0, r.queue - queueHuman) : 0,
        });
    }
    // 有事要说的排前面（L2 更值得打断）
    return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "L2" ? -1 : 1));
}

function pick(r: NavRow, p: NavRow): { kind: AlertKind; level: "L1" | "L2"; text: string } | null {
    // ⚠️ 跃迁判据**只用注册表事实**（`running` / `abnormal` / `queue`），**不拿 `unread` 当门槛**：
    // `unread` 的尺子里有**账本**，而账本是异步到货的 —— 收尾那一帧它常常还慢一拍（实测：
    // 真跑完的时刻 `unread` 算出来是 0，等账本刷新才变成 +2）⇒ 拿它当条件会把"跑完"整个吃掉。
    // `unread` 只用来**措辞**（有未读就说清有几条）。
    const unread = r.unread > 0 ? `，+${r.unread} 条未读` : "";
    // ① 异常终止：唯一（连同"有人在等"）配得上抢焦点的一种。
    //    · `p.running` = 刚在跑、现在停了、且收尾异常（最准的一次跃迁）；
    //    · `!p.abnormal` = 上一次收尾是好的 —— 免掉"看过了又一次异常"这种漏报。
    if (r.abnormal && (p.running || !p.abnormal)) {
        return { kind: "failed", level: "L2", text: `${r.label} 异常终止${unread}` };
    }
    // ② 队列里刚出现留言。**来源要分开**（##435）：队列的收件人是 agent，不是人 ——
    //    `queue` = 待投递给 agent 的留言条数，往里写的不只有人（job 结束通知 / 别的 agent 派活 /
    //    CLI 无署名）。只有**人署名**的几条才叫「有人在等你回复」；否则人类零动作，
    //    却会被 L2 拽到任务页（##435 现场：11 条队列 0 条来自人）。
    if (r.queue > 0 && p.queue === 0) {
        const human = Math.max(0, Math.min(r.queueHuman, r.queue));
        if (human > 0) {
            return { kind: "waiting", level: "L2", text: `${r.label} 有人给你留了 ${r.queue} 条留言（队列里）` };
        }
        return {
            kind: "queued-auto",
            level: "L1",
            text: `${r.label} 有 ${r.queue} 条自动留言待投递（job/agent 生成，你无需回复）`,
        };
    }
    // ③ 无进展（停滞是运行的子集，故只需判"刚进停滞"）
    if (r.stalled && !p.stalled) {
        return { kind: "stalled", level: "L1", text: `${r.label} 在跑但没动静了（该看一眼是不是卡住）` };
    }
    // ④ 跑完（正常收尾）—— 不抢焦点；`opened` 已在调用方挡掉"你正看着它跑完"的情况
    if (p.running && !r.running && !r.abnormal) {
        return { kind: "finished", level: "L1", text: `${r.label} 跑完了${unread}` };
    }
    return null;
}
