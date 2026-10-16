/**
 * user-stamp — 「用户这句话是什么时候说的」（纯函数，零依赖，node 环境可单测）
 *
 * 需求（##331 ②）：user 发言此前**没有任何时间信息**，只显示出「我说过啥」；agent 侧却有两处
 * 时刻（轮尾状态行 `TurnUsageBar` 的 Clock、明细抽屉标题）。要给 user 补齐、且**格式同源**。
 *
 * 数据源（先核实过，别再用渲染时刻冒充）：
 *   · `ops.jsonl` 的 Op **没有 ts 字段**（`local-blocks.ts` 的四类 op 只有 id/kind/parent/meta/fields），
 *     块结构里也没有 —— `shared/date-format.ts` 的头注已把这条写成契约。
 *   · 对话流里**唯一**的时间真源 = **turnId 内嵌的 13 位 epoch 毫秒**（main 用 `t${Date.now()}`
 *     造轮 id，main/services/local-agent.ts）。
 *   · user 块的 id 恰是 `<turnId>_u`（轮首）/ `<turnId>_u2`（轮首批量多条，如轮末队列整批投递）
 *     / `<turnId>_su<n>`（插话）—— 即**块 id 自带所属轮**，而轮起点时刻就是那句"发送即起轮"。
 *
 * 两种精度**绝不混用**（对齐 `assistant-byline` 的 inferred 做法）：
 *   · 轮首 user  → 该轮起点 = 这句话的发送时刻（RPC 往返忽略不计），`exact=true`。
 *   · 插话 user  → 它投递在本轮**中途**，真实时刻无记录（ops 没记）⇒ 显示的仍是**轮起点**，
 *                  `exact=false`，界面必须把这一点说清，不假装精确。
 *   · id 解析不出（改名/迁移前的旧日志）→ **不显示**（宁可没有时间，也不给一个假时刻）。
 */

import { fmtTurnStamp } from "../../shared/date-format";

/** user 文本块 id → 所属轮 turnId（`t` + 13 位毫秒）；不是 user 块 / 形状不认识 = null */
export function turnIdOfUserBlock(blockId: string | undefined | null): string | null {
    if (!blockId) return null;
    const m = /^(t\d{13})_(u\d*|su\d+)$/.exec(blockId);
    return m ? m[1]! : null;
}

export interface UserStamp {
    /** 展示文本（`MM-DD HH:MM`，与 agent 侧同一个 `fmtTurnStamp`） */
    text: string;
    /** hover 说明：这个数是怎么来的（精确 / 轮起点近似） */
    title: string;
    /** true = 就是这句话的发送时刻；false = 只有轮起点可用（插话） */
    exact: boolean;
}

export function userStamp(blockId: string | undefined | null): UserStamp | null {
    const turnId = turnIdOfUserBlock(blockId);
    if (!turnId) return null;
    const text = fmtTurnStamp(turnId);
    if (!text) return null; // turnId 形状不认识 → 没时间可言，不编
    if (/_su\d+$/.test(blockId!)) {
        return {
            text,
            exact: false,
            title: `插话的投递时刻没有记录（ops 无时间戳），这里显示的是**所在轮的起点**（${turnId}）`,
        };
    }
    return { text, exact: true, title: `本轮起点时刻（你发送即起轮；${turnId}）` };
}
