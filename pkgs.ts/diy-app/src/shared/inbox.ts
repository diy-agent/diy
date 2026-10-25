// src/shared/inbox.ts
// 🎯 「通知信箱」的**条目契约**（##429 要求 ④/⑤）。
//
// 背景（为什么必须有一个**会留下来的**东西）：`turn.notice` 只在会话页脚显示 ——
// 用户此刻不在那一页就等于没看见；toast 4 秒后自己消失，也一样。而这两条提示
// （被输出上限截断 / 这一轮花太多钱）恰恰是"事后翻账时最想知道"的事。
//
// 与 `level#inbox`（N1/N2 一律落通知信箱，toast 会消失、信箱不丢）的关系：
// 那条规则的**完整实现**（右上角可回看的全局信箱 UI）在 `tool.wake-gap` 里仍是缺口。
// 本文件只补其中**可判据、可测试**的那一半：条目形状 + 落盘留痕 + `diy notice inbox`
// 可查 + renderer 侧 N1 toast。UI 面板是后续的事，但"不许只闪一下"这条从此成立。
//
// 约定：本文件只放 schema/类型/纯函数，禁止 import node:*（renderer 也要用）。

import { z } from "zod";

/**
 * 条目种类。**只列"跃迁"**（与 `shared/session-alerts.ts` 同一纪律）：
 * 这里每一类都是"刚刚发生了一次花钱/损失"，不是"现在有 N 条未读"这种状态。
 */
export const INBOX_KINDS = ["max-tokens", "cost-step", "cost-turn"] as const;
export const InboxKindSchema = z.enum(INBOX_KINDS);
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * 提示层级（`level#notice` 的 N 尺子）。当前只有 N1：toast 一次（不要求立刻处理），
 * 配信箱兜底（条目落在 jsonl 里，随时可回看）—— 正是 N1 的定义。
 */
export const InboxLevelSchema = z.literal("N1");
export type InboxLevel = z.infer<typeof InboxLevelSchema>;

export const InboxEntrySchema = z.object({
    /** `ib-<毫秒>-<序号>`：唯一且按时间可排（与 model-notice 的 id 同形） */
    id: z.string(),
    ts: z.string().describe("发生时刻（ISO）"),
    level: InboxLevelSchema,
    kind: InboxKindSchema,
    /** 哪个任务（`projects/4/tasks/429`）；跨任务的信箱必须带它，否则回看时对不上账 */
    taskUri: z.string(),
    /** 一句话结论（toast 文案 / `diy notice inbox` 的行首） */
    text: z.string(),
    /** 二级信息三件套（##391）：谁发的 / 为什么现在发 / 机制说明 */
    source: z.string(),
    reason: z.string(),
    detail: z.string(),
    /** 结构化事实（金额、上限、层名……）—— 文案会变，数字不会说谎 */
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

/** 信箱保留上限（条）：只留最近的，够回看就行；文件本身按天不切，靠 ring 之外的行数增长可接受 */
export const INBOX_MAX = 200;

/** 人读一行（`diy notice inbox` 的出口）：`<时刻>  <kind>  <任务>  <结论>` */
export function inboxLineOf(e: InboxEntry): string {
    const t = e.ts.slice(0, 19).replace("T", " ");
    return `${t}  ${e.kind.padEnd(10)}  ${e.taskUri}  ${e.text}`;
}
