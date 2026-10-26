// src/shared/context/compact-notice.ts
// 🎯 压缩后重建记忆提示（##442 刀 2 后半）—— 纯函数，禁止 import node:*
//
// 形态（##442 刀 2 定案，方案 A）：
//   role: user
//   from: agent:system
//   compact: { at, dropped, range, source, more, ask }
// 自占一条 user 消息，放在历史第一条之前；未压缩时不出现。

import { z } from "zod";
import { toYaml } from "./render";
import type { ModelMessage } from "ai";

/**
 * 压缩重建提示（`compact:` 段）的契约。
 *
 * 每个字段都是**数据**，解释上移 `help.compact`（见 envelope.ts 的 `CompactNoticeSchema.describe`）。
 */
export const CompactNoticeSchema = z
    .object({
        at: z
            .string()
            .describe("压缩发生时刻（ISO 8601）；用于判断丢的是哪一次的历史"),
        dropped: z.number().describe("这次丢弃的消息条数（不含保头；保头 = 前 600 token 永远保留）"),
        range: z
            .string()
            .describe("被丢弃的 llm.jsonl 行号区间 `from-to`（1-based，含两端）；按此区间 `sed -n 'A,Bp'` 取原文"),
        source: z.string().describe("turns.jsonl 的绝对路径（bash 直接可用）；按当前问题先搜它找结论线索"),
        more: z.string().describe("ops.jsonl 的绝对路径（bash 直接可用）；需要工具输出原文再去它取"),
        ask: z
            .string()
            .describe(
                "重建记忆指令：告诉模型**先搜 turns 再按需搜 ops**，写出摘要而非抄原文（结论/决策/未完成/踩坑）",
            ),
    })
    .describe(
        "会话历史被压缩后的**重建记忆提示**：自占一条 user 消息（`compact:` 顶层键 + `from: agent:system`），" +
            "放在**历史第一条之前**、system 之后；**没丢消息时不出现**。模型按 `source` / `more` 找回被丢内容。",
    );

export type CompactNotice = z.infer<typeof CompactNoticeSchema>;

/** 固定的重建指令（与 task 442 body 逐字一致） */
export const COMPACT_ASK =
    "先按当前问题在 turns.jsonl 里找回线索（结构化轮次 + 压缩边界）；需要工具输出原文再去 ops.jsonl。写出摘要：结论 / 决策 / 未完成 / 踩坑，不许抄原文。";

/** 把 compact 提示渲染成一段 YAML（自占一条消息的内容；字段说明在 `help.compact`） */
export function renderCompactNotice(note: CompactNotice): string {
    return toYaml({ from: { id: "agent:system" }, compact: note });
}

/** 把 compact 提示挂到历史首条之前（空串 ⇒ 不注入） */
export function withCompactNotice(hist: ModelMessage[], note: string): ModelMessage[] {
    if (!note.trim()) return hist;
    return [{ role: "user", content: note } as ModelMessage, ...hist];
}
