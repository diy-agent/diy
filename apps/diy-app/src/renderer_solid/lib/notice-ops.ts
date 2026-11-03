/**
 * notice-ops.ts — 「会话实时更新」那条**样板提示**的文案真源（##391 验收 1）。
 *
 * 为什么要单列一份：同一条故障有**两个**呈现面 —— ① 会话页常驻条「会话实时更新中断」
 * ② 恢复时的 toast「已恢复」。两处若各写一套机制说明，用户从哪一面点进「详情」都会
 * 读到不同的故事（而真相只有一个），以后改一处忘一处就是再次腐坏。故本文件是唯一真源：
 *   · `OPS_SOURCE`        —— 来源（含代码位置）
 *   · `OPS_MECHANISM`     —— 机制说明（多行）
 *   · `opsDownMeta()`     —— 常驻条的二级信息（原因带「起点时刻 + 已断多久」）
 *   · `opsLiveMeta()`     —— 恢复 toast 的二级信息（原因带「断了几秒：起点 → 终点 + 重订次数」）
 *
 * ⚠️ 口径核对（2026-10-20，##391 落地时逐条查过代码）：
 *   · op 订阅是**唯一**实时通道（##327 单通道化），chat 流不 apply op；
 *   · 断了之后是 **1s 退避重订**（`localChatStore.ts::OPS_RECONNECT_MS = 1000`），
 *     main 侧 `opsFeed.subscribe` 从 `appliedSeq` 起连续补发 `(since, seq]`；
 *   · **没有** ops 轮询兜底（2s 轮询已在 ##307 删除）。页面里那个 2.5s 轮询是**其它东西**
 *     （room 外部行 / 运行态真值），别写进这里的机制说明；
 *   · 另一条发现路径是**轮末自检**（`settleOpsAfterTurn`：本轮有 op 但水位没前进 → 立刻重订），
 *     它兜的正是「流连着却一帧都不来」的哑流。
 */
import { formatClock, formatDuration, type NoticeMeta } from "./notice";

/** 来源：机制名 + 代码位置（用户/agent 都能顺着它找到实现） */
export const OPS_SOURCE = "会话实时更新 · op 增量订阅 opsWatch（localChatStore.ts::ensureOpsSubscription）";

/** 机制说明（多行；常驻条与恢复 toast 共用同一份 —— 改口径只改这里） */
export const OPS_MECHANISM = [
    "在监测什么：会话页的实时更新只有一条通道 —— op 增量订阅（opsWatch）。收到帧才算通；它一断，界面不会自己冒出任何新内容，而那种状态与「模型还在想」长得一模一样。",
    "为什么会有这条：订阅被关闭 / 超时 / main 侧关流时，界面先亮常驻条「会话实时更新中断」；本条是对那段故障的**收尾** —— 只有「刚恢复」才弹一次，正常连接不会弹。",
    "断线期间界面是什么样：已经看到的字不会消失，只是不再增长（历史一条不丢）；期间别人/模型写的增量暂时看不到。",
    "怎么恢复：每 1 秒自动重订一次（不是轮询数据，而是按「已应用到 ops.jsonl 第几行」重订），main 侧从那行起连续补发，断线期间的增量按原样补齐。轮末还有一次自检：这一轮明明产出了 op 而水位没前进，就立刻重订（兜住「流连着却一帧都不来」的哑流）。",
    "恢复意味着什么：可以继续看实时输出了；补齐是「按行号追加」，不会重复、也不会跳段。",
    "怎么消：4 秒后自动消失，或点 ✕；想留证据就用面板里的「复制」。",
].join("\n");

/** 常驻条（中断中）的二级信息：原因里必须有「起点时刻」，否则用户不知道已经断了多久 */
export function opsDownMeta(p: { since: number | null; now: number; reconnects: number }): NoticeMeta {
    const at = p.since ? formatClock(p.since) : "(起点未知)";
    const dur = p.since ? formatDuration(Math.max(0, p.now - p.since)) : "(未知)";
    return {
        source: OPS_SOURCE,
        reason:
            `订阅自 ${at} 起中断，已持续 ${dur}；本段内已自动重订 ${p.reconnects} 次` +
            `（每 1s 一次，重订成功后按行号连续补发，历史不丢）`,
        detail: OPS_MECHANISM,
    };
}

/** 恢复 toast 的二级信息：原因里必须有「断了几秒 + 起止时刻」（验收 1 的字面要求） */
export function opsLiveMeta(p: { from: number | null; to: number; reconnects: number }): NoticeMeta {
    const dur = p.from ? formatDuration(Math.max(0, p.to - p.from)) : "(时长未知)";
    const span = p.from ? `${formatClock(p.from)} → ${formatClock(p.to)}` : `(起点未知) → ${formatClock(p.to)}`;
    return {
        source: OPS_SOURCE,
        reason: p.from
            ? `订阅中断 ${dur}（${span}）后恢复；期间自动重订 ${p.reconnects} 次，断线增量已按行号补齐`
            : `订阅已恢复（${formatClock(p.to)}）；本段故障起点未能记录，期间自动重订 ${p.reconnects} 次`,
        detail: OPS_MECHANISM,
    };
}
