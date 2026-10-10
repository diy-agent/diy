/**
 * 轮次折叠 / 展开级别的**语义**（纯函数，可单测）——组件只负责画。
 *
 * 为什么单独一层：折叠态"显示什么、按什么序、展开到第几层"是语义而不是样式，
 * 错一次就是"用户发言被拽到助理回复下面"（2026-10-04 现象：顺序不对）。
 * 语义放这里用测试钉住，LocalChatPage 只消费结果。
 */

import type { BlockNode } from "../../main/services/local-blocks";

/** 用户发言块（插话与轮次开场那次发言同形，只差 attrs.steer） */
export function isUserText(n: BlockNode): boolean {
    return n.tag === "text" && n.attrs.role === "user";
}

/** 过程块：think / tool（分段、实时区都只认这两种） */
export function isProc(n: BlockNode): boolean {
    return n.tag === "think" || n.tag === "tool";
}

/**
 * 文档序拉平：叶子块（step 是纯容器，DFS 顺序 = 时间顺序）。
 * 渲染只按此序 + 折叠策略决定可见性，**绝不按 kind 重排**（时序是协议的基本承诺）。
 * 兼底：任何带 children 的容器都向下递归，否则一旦数据里出现嵌套容器
 * （如旧日志中的嵌套 turn），整段子树会直接不渲染。
 */
export function leavesOf(turn: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    const walk = (n: BlockNode) => {
        for (const c of n.children) {
            if (c.tag === "step" || c.children.length > 0) walk(c);
            else out.push(c);
        }
    };
    walk(turn);
    return out;
}

/** 最后一条助理正文（折叠态那条"要不要截断"的主角；没有则 null） */
export function lastAssistantText(turn: BlockNode): BlockNode | null {
    const a = leavesOf(turn).filter((n) => n.tag === "text" && !isUserText(n));
    return a[a.length - 1] ?? null;
}

/**
 * 轮首的**用户发言**（文档序开头连续的用户 text）—— IM 顺序下它们排在轮次头之前。
 *
 * 为什么单独拆出来（2026-10-11 现象"助理发言排在了用户前面"）：
 *   轮次头 = 助理的身份行（🤖 人物 · 模型 · 统计）。它渲染在轮首时，视觉上就是
 *   "助理先开口，用户后说话" —— 与 IM 里"用户先说、对方再接"的直觉相反。
 *   判据：用户发言在前导段里 ⇒ 渲染序为 [用户气泡] → [轮次头] → [内容]。
 *
 * 只取**开头连续**的用户块：轮次中间的插话（steer）必须留在原地（文档序即时间序），
 * 提前等于又一次重排（2026-10-04 那个坑）。
 */
export function leadUsers(turn: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    for (const n of leavesOf(turn)) {
        if (!isUserText(n)) break;
        out.push(n);
    }
    return out;
}

/**
 * 折叠态可见项 —— **严格文档序，不重排**。
 *
 * 历史教训（2026-10-04）：上一版是「全部用户发言 → 实时行 → 最后一条正文」三段拼接。
 * 而插话块在文档序上位于轮次**中间**（用户在第 38 步与第 39 步之间发的），
 * 折叠后它被拽到轮首 → 与它后面那条助理回复的相对顺序颠倒，看着像"助理先说、用户后说"。
 * 现在只做"藏中间过程"，不做"搬位置"：
 *   · 用户发言 —— 恒显（"我说过啥"的脉络本体；插话必须就地）；
 *     **但轮首那批由调用方先行渲染**（见 leadUsers），否则会与轮次头顺序打架
 *     —— 组件渲染时须把它们从本列表里剔掉，不剔就是同一句画两遍
 *   · error 块 —— 恒显（一轮报错后折叠起来与成功轮次长得一模一样 = 信息丢失）
 *   · 最后一条助理正文（结论）—— 由 `opts.conclusion` 决定要不要（1 级全收缩时不要）
 *   · 其余（更早的正文、连续过程）一律收起，展开轮次才见
 */
export function foldedItems(
    turn: BlockNode,
    opts: { conclusion?: boolean } = {},
): BlockNode[] {
    const withConclusion = opts.conclusion !== false;
    const last = withConclusion ? lastAssistantText(turn) : null;
    const out: BlockNode[] = [];
    for (const n of leavesOf(turn)) {
        if (isUserText(n) || n.tag === "error" || n === last) out.push(n);
    }
    return out;
}

/** 实时区的形状：见 `liveAreaOf` */
export interface LiveArea {
    node: BlockNode;
    /** true = 该步正在跑（给出展开体）；false = 已跑完、在等下一步（只留标题行 + ⋯） */
    active: boolean;
}

/**
 * 直播轮次的"当前活动"（渲染在轮尾）。
 *
 * 目标（用户 2026-10-04）：两步之间不要再留"什么都没有"的空白期 —— 模型在决定下一步
 * 干什么的那几秒里，界面必须仍然说明"在等什么"。
 *   ① 最后一步**正在跑**（未定稿）→ 它就是当前活动，展开体给出来（当前 tool 命令行 / think 正文）；
 *   ② 最后一步**已定稿但之后还没有助理内容** → 它留在原位不消失（冻结成标题行），
 *      底下挂一条 `⋯ 等待下一步`；新步一开始，整块内容被替换掉；
 *   ③ 它之后已有助理内容在流（正文/计划/错误）→ 那块内容本身就是"当前活动"，实时区让位。
 *
 * 调用方必须把 `node` 从文档序渲染里剔除：否则同一块画两遍（2026-10-04 review P1-1：
 * 展开态 ProcessRow 与轮尾 delta 行各画一次，同一句出现两遍）。
 */
export function liveAreaOf(turn: BlockNode, isLive: boolean): LiveArea | null {
    if (!isLive) return null;
    const leaves = leavesOf(turn);
    const procs = leaves.filter(isProc);
    const last = procs[procs.length - 1];
    if (!last) return null;
    if (!last.stopped) return { node: last, active: true };
    const after = leaves.slice(leaves.indexOf(last) + 1);
    if (after.some((n) => !isUserText(n))) return null;
    return { node: last, active: false };
}

// ─── 展开级别（像 JSON 树那样一层一层点开） ──────────────

/**
 * 轮次展开级别（**每轮各自一份**，2026-10-11 用户口径：取消「正常/大纲」两态开关，
 * 改成"点一下展开一层、再点一下再展开一层"的级别循环）。
 *
 *   1 全收缩   —— 只有轮次头（身份/统计那一行）；连结论也收起
 *   2 结论     —— + 末条助理正文（截 N 行、带渐隐与提示行）
 *   3 全部正文 —— + 其余正文与过程图标行（连续已定稿的 think/tool 折成一行图标）
 *   4 逐条过程 —— 图标行铺开成"每事件一行"的单行标题
 *   点完 4 再点 → 回到 1（循环）
 *
 * **工具/思考的正文（详情层）不在这条循环里**：那是用户自己点开的那一下（见 procOpen），
 * 级别按钮不管它 —— 否则"看某个工具的完整输出"要被级别状态牵着走。
 */
export type TurnLevel = 1 | 2 | 3 | 4;

export const TURN_LEVEL_MIN = 1;
export const TURN_LEVEL_MAX = 4;

/** 默认级别：3（全部正文 + 过程图标行）—— 打开会话就能读到内容，但过程仍收成一行 */
export const DEFAULT_TURN_LEVEL: TurnLevel = 3;

export function isTurnLevel(v: unknown): v is TurnLevel {
    return v === 1 || v === 2 || v === 3 || v === 4;
}

/** 循环：1→2→3→4→1。越界值按默认级别起步（脏状态不卡死在这一轮） */
export function cycleTurnLevel(level: TurnLevel): TurnLevel {
    return (level >= TURN_LEVEL_MAX ? TURN_LEVEL_MIN : level + 1) as TurnLevel;
}

/** 级别名（给 aria / tip 用；界面上不写死文案，改级别只改这里） */
export function turnLevelLabel(level: TurnLevel): string {
    if (level === 1) return "全收缩";
    if (level === 2) return "结论";
    if (level === 3) return "全部正文";
    return "逐条过程";
}

/** hover / 读屏说明：第几层 + 这一层有什么 + 点一下会到哪 */
export function turnLevelTip(level: TurnLevel): string {
    return `展开级别 ${level}/${TURN_LEVEL_MAX}（${turnLevelLabel(level)}）· 点击展开下一层`;
}

/** 每一级"看得见什么"（组件据此渲染，判断只此一处） */
export interface LevelPlan {
    /** 结论（末条助理正文）可见 —— 2 级起 */
    conclusion: boolean;
    /** 除结论外的正文 + 过程图标行可见 —— 3 级起 */
    allTexts: boolean;
    /** 过程图标行铺开成逐条单行 —— 4 级 */
    stripRows: boolean;
}

export function planOfLevel(level: TurnLevel): LevelPlan {
    return {
        conclusion: level >= 2,
        allTexts: level >= 3,
        stripRows: level >= 4,
    };
}

/**
 * 按可视行数截断正文（2 级「结论」的摘要态；Markdown 不解析时也走这里）。
 *
 * 只截**行**不截字符：正文里代码块/列表被字符数切开比少几行更难看懂。
 * 返回 omitted（被藏起来的行数）而不是布尔 —— 界面要说出"还有几行"，
 * 光一个 `…` 信息量太低（2026-10-11 用户反馈：看不出被裁过）。
 */
export function clampLines(text: string, n: number): { text: string; omitted: number } {
    const lines = text.split("\n");
    if (lines.length <= n) return { text, omitted: 0 };
    return { text: lines.slice(0, n).join("\n"), omitted: lines.length - n };
}
