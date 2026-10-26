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
 * `message` / `lost` 是 ##436 加的（前三条是 ##429 的损失型）：
 *   · `message` —— 有留言被投给某个会话（人 / job / 别的 agent 写的都算）：这正是
 *                  用户被「叫醒」却看不到内容的那一类，进信箱后才有原文可读；
 *   · `lost`    —— 任务已结案而插话队列里还压着留言 ⇒ **没有下一次轮次来取走它**
 *                  （##229 的现实现场：`projects/4/tasks/229` 的 `.diy/drafts.yaml`
 *                  里那条 `steer/1`，任务从 2026-10-04 起就是 done）。
 *
 * ⚠️ **不叫 `delivery-lost`**（曾经叫过，改名理由）：`t266.room#queues` 里说的
 * `deliveries.jsonl` 是**补救方向**而不是现存数据 —— 全盘 `fd deliveries.jsonl` 是 0 个文件。
 * 拿一个不存在的东西命名的 kind，会让后来人以为有个"投递账"可查。真实现场只有一种：
 * **结案的会话里没人取的队列项**（`lost` 就是这个意思：留言没丢，但永远取不出来）。
 *
 * 另一个必须写进文案的边界：**它是可逆的**。任务随时可以 `task edit … active`，那时这条
 * 留言就又能被取走 —— 所以条目文案是「已结案 ⇒ 现在不会被取出；改回 active 就能生效」，
 * 不是「已丢弃」（##416：不隐藏信息，说清为什么没被消费 + 怎么救）。
 */
export const INBOX_KINDS = ["max-tokens", "cost-step", "cost-turn", "message", "lost"] as const;

/** kind → 中文短名（列表一行用；文案真源在这一处，别在组件里各写一份） */
export const INBOX_KIND_LABEL: Readonly<Record<InboxKind, string>> = {
    "max-tokens": "输出截断",
    "cost-step": "单步超支",
    "cost-turn": "单轮超支",
    message: "新留言",
    lost: "滞留留言",
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
 * 条目 id → **单调序**（`ib-<毫秒>-<序号>`）：同毫秒内比序号，跨毫秒比毫秒。
 *
 * 为什么需要它：「未读 = id 比水位新」这条只有在 id **全局单调递增**时才成立。
 * id 由 main 侧 `inboxEntryOf` 生成：毫秒 + 进程内自增序号（序号补零到 4 位，
 * 于是纯字符串比较也单调）—— 解析放在这里，是为了让 renderer 侧不必知道格式。
 * 解析不了（旧格式 / 手写）⇒ `null`，调用方按"判不出来"处理（见 `unreadCountOf`）。
 */
export function inboxIdOrderOf(id: string): { ms: number; seq: number } | null {
    const m = /^ib-(\d+)-(\d+)$/.exec(id);
    if (!m) return null;
    const ms = Number(m[1]);
    const seq = Number(m[2]);
    return Number.isSafeInteger(ms) && Number.isSafeInteger(seq) ? { ms, seq } : null;
}

/** `a` 是否比 `b` 新（同 id = 不新）。任一侧解析不了 ⇒ 退回字符串序（只当兜底，不参与判据） */
export function isNewerInboxId(a: string, b: string): boolean {
    const x = inboxIdOrderOf(a);
    const y = inboxIdOrderOf(b);
    if (!x || !y) return a > b;
    return x.ms !== y.ms ? x.ms > y.ms : x.seq > y.seq;
}

/**
 * 未读数 = 比水位（`lastReadId`）**新**的条目条数（##436 块 3）。
 *
 * 判据（单测 `tests/core/inbox-unread.test.ts` 钉住）：
 *   · `lastReadId` 为空 ⇒ 全部未读（新装 / 清过视图 cache）；
 *   · 水位解析不了（旧格式 / 脏值）⇒ 全部未读 —— **宁可多报一次，也不谎报已读**；
 *   · 水位比所有条目都旧（被 `INBOX_MAX` ring 挤掉）⇒ 全部未读（本来也都没证过已读）；
 *   · 水位比所有条目都新（**inbox 被清空 / 换过数据根**）⇒ **0**，不许出现负数；
 *   · 否则 = id 比它新的那几条（数量与"位置"口径一致，只是不再依赖条目数组顺不顺序）。
 */
export function unreadCountOf(entries: readonly InboxEntry[], lastReadId: string | null | undefined): number {
    return unreadBreakdownOf(entries, lastReadId).total;
}

/** 未读的**分级**（##266 复核阻塞 1）：`n2` = 真的有人在等你，`n1` = 只是记一笔。 */
export type InboxUnread = { n2: number; n1: number; total: number };

/**
 * 未读按等级拆开（##266 复核阻塞 1）。
 *
 * 为什么必须拆：顶栏角标是**催人**的信号，而信箱**全收**（人 / agent / job 都进）。
 * 只数总数 ⇒ ##423 / ##432 那种 agent↔agent 派活（全 N1）也会把角标顶起来，用户点开一看
 * 全是机器互聊 —— 那正是「把我拉到几个任务页面好几次，但都没啥要回复的」的体感来源。
 * 所以：**角标只数 N2**（`badgeUnreadOf`），列表照显全部条目（`entries` 全量，不受等级影响）。
 *
 * 水位判据与 `unreadCountOf` 完全同源（一个实现，别分叉）：水位判不出来 / 比所有条目都旧
 * ⇒ 全部算未读；比所有条目都新（清空 / 换数据根）⇒ 0。
 */
export function unreadBreakdownOf(
    entries: readonly InboxEntry[],
    lastReadId: string | null | undefined,
): InboxUnread {
    const trustable = Boolean(lastReadId) && Boolean(inboxIdOrderOf(lastReadId ?? ""));
    let n2 = 0;
    let n1 = 0;
    for (const e of entries) {
        if (trustable && !isNewerInboxId(e.id, lastReadId!)) continue;
        if (e.level === "N2") n2++;
        else n1++;
    }
    return { n2, n1, total: n2 + n1 };
}

/** 角标该显示几（= 未读里的 **N2**；N1 不进角标，只在面板里列出） */
export function badgeUnreadOf(entries: readonly InboxEntry[], lastReadId: string | null | undefined): number {
    return unreadBreakdownOf(entries, lastReadId).n2;
}

/** 水位该挪到哪（= 最新一条的 id；空信箱 = `null`，别写个空串进 cache） */
export function latestIdOf(entries: readonly InboxEntry[]): string | null {
    let best: string | null = null;
    for (const e of entries) if (best === null || isNewerInboxId(e.id, best)) best = e.id;
    return best;
}

/**
 * **已读水位的存储形态**：`<数据根>|<条目 id>` —— 一条字符串，两种信息。
 *
 * 为什么必须带数据根（##266 的硬要求）：lab（`build/home`）与 production（`~/.diy`）是
 * 两个世界，但 localStorage 是**同一个**（同一个 Electron userData）—— 只按任务 id 存水位，
 * 在 lab 里点开面板就会把 production 的未读一把清掉。数据根不同 ⇒ 水位互不相认。
 *
 * 用 `|` 分隔：路径里不会出现它，且从**右侧第一个** `|` 切就能容忍带 `|` 的怪路径。
 */
export const INBOX_WATERMARK_SEP = "|";
export function watermarkStoreOf(dataRoot: string, id: string): string {
    return id ? `${dataRoot}${INBOX_WATERMARK_SEP}${id}` : "";
}

/** 取出「属于这个数据根」的水位 id；数据根对不上 / 空 / 脏 ⇒ `""`（= 全部未读） */
export function watermarkIdOf(stored: string | null | undefined, dataRoot: string): string {
    if (!stored) return "";
    const at = stored.lastIndexOf(INBOX_WATERMARK_SEP);
    if (at < 0) return ""; // 老形态（裸 id，没有数据根）：判不出归属 ⇒ 不认，宁可多报未读
    return stored.slice(0, at) === dataRoot ? stored.slice(at + 1) : "";
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
