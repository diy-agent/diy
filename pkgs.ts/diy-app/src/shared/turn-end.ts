// src/shared/turn-end.ts
// 🎯 轮次**结束原因 → 人话 / 图标**的唯一文案源（main 与 renderer 共用，纯函数）。
//
// 【为什么单独一层（##308 收编 ##305 review2 的 R4）】
//   改造前同一件事有两份说法，且**各写各的**：
//     · main：`local-agent.ts` 的 `abortNotice(_source)` —— 参数无人读，恒回「生成已取消」；
//     · renderer：`chat-fold.ts` 的 `turnEndNote` —— 按 `source === "detached"` 分叉出「流中断」。
//   于是同一个 `aborted` 在错误块（main 写进 op 流）里是「生成已取消」、在轮尾状态行（renderer 翻）
//   里是「本轮被中断（未跑完）」—— 一个轮次两个结论，用户无从判断到底是谁结束的。
//   现在**两边都调这里的函数**：改文案只改一处，也不可能再分叉。
//
// 【aborted 的两句（不许塌成一句）】
//   用户主动停止 ≠ 流意外中断 —— 前者是预期收尾，后者是故障。判据是 `TurnEndReason.data.source`：
//     · `"user"`     —— `cancel()` 显式 `abort({source:"user"})`（用户点了停止）
//     · `"detached"` —— 流意外中断 / 没跑完的兜底（##305 起消费端断开**不再**产生它）
//     · 其余（旧日志里的 `"abort"` 等）—— 按"被中断、未跑完"说，不冒充用户停止
//   旧记录里用户停止也是 `"abort"`（当时没带 reason）⇒ 它们显示第三句，与当时一致，不算行为回归。

import type { TurnEndReason } from "../main/services/local-blocks";

/**
 * 中止的可见文案（**唯一一处**）。main 的 `error{abort}` 块与 renderer 的轮尾说明都调它。
 */
export function abortText(source: string): string {
    switch (source) {
        case "user":
            return "生成已取消";
        case "detached":
            return "本轮被中断（流中断，未跑完）";
        default:
            return "本轮被中断（未跑完）";
    }
}

/**
 * 结束原因的**说明句**（`notice` 优先 —— 它更细，含限制值等）。
 *
 * 返回 null = 这件事没有额外可说的（`completed` / `error` 的细节归轮尾现场与 error 块，
 * 同一句话不写两遍）。renderer 的 `turnEndNote` 与任何要"把 endReason 翻成人话"的地方都走这里。
 */
export function turnEndText(r: TurnEndReason, notice?: string | null): string | null {
    const n = notice ? notice : null;
    switch (r.type) {
        case "completed":
            return n;
        case "max-steps":
            return n ?? `达到步数上限 ${r.data.limit}，本轮被强制收尾（模型仍在请求工具）`;
        case "max-tokens":
            return n ?? "输出达到上限被截断";
        case "aborted":
            return abortText(r.data.source);
        case "error":
            return n; // 细节由 error 块 / 现场说，同一句不写两遍
        case "interrupted":
            return "本轮未完成（流中断/崩溃恢复）";
    }
}

/**
 * 轮尾**状态行**的状态图标（末行恒显 —— 它是"这轮到底怎么结束的"的唯一常显位）。
 *
 * 用户 2026-10-11 口径："我起码知道是模型说我正常结束了，还是模型说有长度/金额限制所以要结束了，
 * 还是压根没收到 llm 结束"。`endReason`（##288 拍板）是判据，这里只把它翻成一个字形 + 一句 tip。
 * **字形承载状态、文字只进 tooltip**（用户 2026-10-12：状态行上不写"正常结束"这类字）。
 *
 * tone 三档给样式用（不是给判据用）：`ok` 绿 · `cut` 黄（被限制/被中断，非报错）· `err` 红 ·
 * `live` 灰（进行中）。无 `endReason` 的旧日志 → 不给图标（`icon: ""`，不编状态）。
 */
export interface EndMark {
    icon: string;
    tip: string;
    tone: "live" | "ok" | "cut" | "err" | "none";
}

export function endMarkOf(end: TurnEndReason | null, live: boolean): EndMark {
    if (live) return { icon: "◌", tip: "本轮进行中", tone: "live" };
    if (!end) return { icon: "", tip: "", tone: "none" };
    switch (end.type) {
        case "completed":
            return { icon: "✓", tip: "正常结束（completed）", tone: "ok" };
        case "max-steps":
            return { icon: "⛔", tip: `步数上限收尾（上限 ${end.data.limit}）`, tone: "cut" };
        case "max-tokens":
            return { icon: "⛔", tip: "输出长度上限", tone: "cut" };
        case "aborted":
            return { icon: "⛔", tip: abortText(end.data.source), tone: "cut" };
        case "interrupted":
            return { icon: "⛔", tip: "未完成（流中断/崩溃恢复）", tone: "cut" };
        case "error":
            return { icon: "✗", tip: "错误终止", tone: "err" };
    }
}
