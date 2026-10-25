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
 * 这里每一类都是"刚刚发生了一次花钱/损失/有人说话"，不是"现在有 N 条未读"这种状态。
 *
 * `message` / `delivery-lost` 是 ##436 加的（前三条是 ##429 的损失型）：
 *   · `message`       —— 有留言被投给某个会话（人 / job / 别的 agent 写的都算）：这正是
 *                        用户被「叫醒」却看不到内容的那一类，进信箱后才有原文可读；
 *   · `delivery-lost` —— 投递账上停在 `queued`/`running` 而进程重启 ⇒ 那条话再没有人会看到
 *                        （t266.room#queues 记的 zombie 账）。**不许静默**，至少留一条可读条目。
 */
export const INBOX_KINDS = ["max-tokens", "cost-step", "cost-turn", "message", "delivery-lost"] as const;

/** kind → 中文短名（列表一行用；文案真源在这一处，别在组件里各写一份） */
export const INBOX_KIND_LABEL: Readonly<Record<InboxKind, string>> = {
    "max-tokens": "输出截断",
    "cost-step": "单步超支",
    "cost-turn": "单轮超支",
    message: "新留言",
    "delivery-lost": "投递丢失",
};
export const InboxKindSchema = z.enum(INBOX_KINDS);
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * 提示层级（`level#notice` 的 N 尺子）。
 *
 *   · `N1` —— 只落信箱（toast 一次，不要求立刻处理）：撞上限 / 成本告警 / **机器写的留言**；
 *   · `N2` —— 页面顶栏图标 / 角标（##436 的喇叭就是它）：**人署名**的留言（##435 的判据：
 *     队列的收件人是 agent，只有人写的那几条才真的"有人在等你回复"）。
 *
 * 两者**都**进信箱（`level#inbox`：N1/N2 一律落信箱，toast 会消失、信箱不丢）；差别只在
 * 「值不值得抬头看一眼」。判据本身不在这里 —— `message` 的 N1/N2 由 main 侧
 * `core/drafts.isHumanAuthor` 决定（与 `session-alerts` 的 L1/L2 同一把尺子）。
 */
export const InboxLevelSchema = z.enum(["N1", "N2"]);
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

/**
 * 未读数 = 水位（`lastReadId`）**之后**的条目条数（##436 块 3）。
 *
 * 判据三条（单测 `tests/core/inbox-unread.test.ts` 钉住）：
 *   · `lastReadId` 为空 ⇒ 全部未读（新装 / 清过视图 cache）；
 *   · `lastReadId` 在入参里找不到（被 `INBOX_MAX` ring 挤掉了）⇒ **全部未读**：
 *     找不到水位就无法证明"这几条看过了"，宁可多报一次也不谎报已读；
 *   · 否则 = 它后面那几条。
 *
 * 为什么比"位置"而不比 id 大小：id = `ib-<毫秒>-<序号>`，同一毫秒内序号单调，但跨毫秒
 * 只靠字符串比大小也可用 —— 不过入参本就按时间升序（`inboxHub.list` 的口径），按位置
 * 找更稳（历史里混进旧格式 id 时不至于算错整批）。
 */
export function unreadCountOf(entries: readonly InboxEntry[], lastReadId: string | null | undefined): number {
    if (!lastReadId) return entries.length;
    const at = entries.findIndex((e) => e.id === lastReadId);
    if (at < 0) return entries.length;
    return entries.length - at - 1;
}

/** 水位该挪到哪（= 最新一条的 id；空信箱 = `null`，别写个空串进 cache） */
export function latestIdOf(entries: readonly InboxEntry[]): string | null {
    return entries.length > 0 ? entries[entries.length - 1]!.id : null;
}

/** 徽标文字：0 = 不显示数字（图标恒在），>99 = `99+`（##436 块 1） */
export const INBOX_BADGE_MAX = 99;
export function inboxBadgeOf(unread: number): string {
    if (unread <= 0) return "";
    return unread > INBOX_BADGE_MAX ? `${INBOX_BADGE_MAX}+` : String(unread);
}

/**
 * 一条条目该跳到哪（##436 块 3）：**只给能定位的锚点**，给不出就不假装。
 *
 * 返回 `null` 的语义 = 「打开会话、但定位不到具体轮次」—— 调用方必须把这句话**说出来**
 * （body 硬要求：不许只开 tab 不定位还不说）。有了 `turnId`/`blockId`/`steerId` 之一，
 * 会话页会自己滚过去（`lib/chat-nav`）。
 */
export interface InboxJump {
    taskUri: string;
    turnId?: string;
    blockId?: string;
    steerId?: string;
}
export function jumpOf(entry: InboxEntry): InboxJump {
    const d = entry.data ?? {};
    const pick = (k: string): string | undefined => {
        const v = d[k];
        return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    return { taskUri: entry.taskUri, turnId: pick("turnId"), blockId: pick("blockId"), steerId: pick("steerId") };
}

/** 有没有可直接用的锚点（`taskUri` 不算 —— 那是"打开"，不是"定位"） */
export function hasAnchorOf(j: InboxJump): boolean {
    return !!(j.turnId || j.blockId || j.steerId);
}

/**
 * 一行摘要：折空白 + 截断（列表里的「一句话结论」用）。
 *
 * 为什么折空白：留言是多行 markdown（`\n` 直接进 DOM 会把一行撑成好几行，列表就乱了）。
 * 原文不丢 —— 它整段进 `data.raw`，面板展开可读全文（##436 块 2 的直接解药）。
 */
export function inboxPreviewOf(text: string, max = 60): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
