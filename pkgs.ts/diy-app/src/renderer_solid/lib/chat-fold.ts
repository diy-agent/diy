/**
 * 轮次折叠 / 展开级别的**语义**（纯函数，可单测）——组件只负责画。
 *
 * 为什么单独一层：折叠态"显示什么、按什么序、展开到第几层"是语义而不是样式，
 * 错一次就是"用户发言被拽到助理回复下面"（2026-10-04 现象：顺序不对）。
 * 语义放这里用测试钉住，LocalChatPage 只消费结果。
 *
 * 一个轮次在界面上分三段，判据各自成函数：
 *   ① 轮首用户发言 `leadUsers` —— 渲染在轮次头**之前**（IM 顺序：用户先说、对方再接）
 *   ② 中间内容 `foldedItems`（1-2 级）/ `contentItems`（3 级起）
 *   ③ 轮尾实时区 `liveAreaOf` —— 只有直播轮次有
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

/** 最后一条助理正文（1 级摘要 / 2 级全文 / 3 级起单独成项的**结论**就是它；没有则 null） */
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
 * 1-2 级的内容区（结论 + 用户发言 + error）—— **严格文档序，不重排**。
 *
 * 历史教训（2026-10-04）：上一版是「全部用户发言 → 实时行 → 最后一条正文」三段拼接。
 * 而插话块在文档序上位于轮次**中间**（用户在第 38 步与第 39 步之间发的），
 * 折叠后它被拽到轮首 → 与它后面那条助理回复的相对顺序颠倒，看着像"助理先说、用户后说"。
 * 现在只做"藏中间过程"，不做"搬位置"：
 *   · 用户发言 —— 恒显（"我说过啥"的脉络本体；插话必须就地）；
 *     **但轮首那批由调用方先行渲染**（见 leadUsers），否则会与轮次头顺序打架
 *     —— 组件渲染时须把它们从本列表里剔掉，不剔就是同一句画两遍
 *   · error 块 —— 恒显（一轮报错后折叠起来与成功轮次长得一模一样 = 信息丢失）
 *   · 最后一条助理正文（结论）—— **恒显**：1 级压成 N 行摘要、2 级给全文。
 *   · 其余（更早的正文、全部过程）一律收起，3 级才见（见 contentItems）
 */
export function foldedItems(turn: BlockNode): BlockNode[] {
    const last = lastAssistantText(turn);
    const out: BlockNode[] = [];
    for (const n of leavesOf(turn)) {
        if (isUserText(n) || n.tag === "error" || n === last) out.push(n);
    }
    return out;
}

// ─── 3 级起的中间区：紧凑行 ──────────────────────────────

/** 3 级起「中间区」的一项（文档序） */
export type ContentItem =
    | { kind: "user"; key: string; node: BlockNode }
    | { kind: "error"; key: string; node: BlockNode }
    | { kind: "conclusion"; key: string; node: BlockNode }
    | { kind: "row"; key: string; text: BlockNode | null; parts: BlockNode[] };

/**
 * 3 级起的中间区（文档序、不重排）。
 *
 * 用户 2026-10-11 口径：一轮的产出节奏是「若干个思考/工具 → 一条正文 → 再来一些思考/工具
 * → 又一条正文 …… 最后是结论」。中间那些**正文与过程条不该各占一行**：攒着的过程
 * （`parts`）与**收束它的那条正文**合成**一行的紧凑行**（`row`），一条正文收一行
 * （"只有新来的正文才换行"）。展开这一行（4 级、或用户手点这一行）就还是原样：
 * 逐条正文 + 逐条过程单行。
 *
 * 单独成项、不并入紧凑行的三种：
 *   · 用户发言（含插话）—— 脉络本体，且必须就地（提前 = 又一次重排）
 *   · error 块 —— 收进紧凑行就看不见了（一轮报错后与成功轮次长得一样 = 信息丢失）
 *   · **结论**（末条助理正文）—— 它是答案：2 级起就全文可见，压进紧凑行等于把答案藏了
 *
 * 轮首用户发言由调用方先画（见 leadUsers），此处排除，避免同一句画两遍。
 * `skip` 给调用方剔除**实时区那一个节点** —— 它在轮尾单独画（展开体给当前 tool/think），
 * 留在文档序里就是同一块画两遍（2026-10-04 review P1-1）。
 */
export function contentItems(turn: BlockNode, skip?: (n: BlockNode) => boolean): ContentItem[] {
    const lead = new Set(leadUsers(turn));
    const last = lastAssistantText(turn);
    const out: ContentItem[] = [];
    let parts: BlockNode[] = []; // 非正文叶子（think/tool/plan…），文档序
    let text: BlockNode | null = null; // 收束本行的那条正文
    let first: BlockNode | null = null; // 本行首个叶子（行键取它 —— 跨帧稳定）
    const flush = () => {
        if (!first) return;
        out.push({ kind: "row", key: first.id, text, parts });
        parts = [];
        text = null;
        first = null;
    };
    for (const n of leavesOf(turn)) {
        if (lead.has(n) || skip?.(n)) continue;
        if (isUserText(n)) {
            flush();
            out.push({ kind: "user", key: n.id, node: n });
        } else if (n.tag === "error") {
            flush();
            out.push({ kind: "error", key: n.id, node: n });
        } else if (n === last) {
            flush();
            out.push({ kind: "conclusion", key: n.id, node: n });
        } else {
            if (!first) first = n;
            if (n.tag === "text") {
                // 正文收束本行 —— 它**不进 parts**（那条正文由组件按原样渲染，
                // 进了 parts 就会被当成"未知块"再画一次）
                text = n;
                flush();
            } else {
                parts.push(n);
            }
        }
    }
    flush();
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
 * 调用方必须把 `node` 从文档序渲染里剔除（`contentItems` 的 `skip`）：否则同一块画两遍
 * （2026-10-04 review P1-1：展开态过程行与轮尾 delta 行各画一次，同一句出现两遍）。
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

// ─── 展开级别 ────────────────────────────────────────

/**
 * 轮次展开级别（像 JSON 树那样一层比一层细）。
 *
 * 2026-10-11 用户口径（第三次修正）：
 *   1 摘要结论 —— 轮次头 + 末条助理正文，**压成 N 行摘要**（底部渐隐 + "还有 N 行"提示行）
 *   2 完整结论 —— 轮次头 + 末条正文**全文**（其余仍不显示）
 *   3 紧凑过程 —— + 中间区：**过程与收束它的正文合一行**（见 contentItems）
 *   4 全部展开 —— 紧凑行铺开成"逐条正文 + 逐条过程单行"
 *
 * **级别循环只归顶部那一个按钮**（`cycleTurnLevel`，对所有轮次一起换层）；
 * 单轮不做循环 —— 点轮次头就是"把我这条展开 / 收拢"两态（见 `levelOfTurn`）。
 * 4 级那个"铺开"也能被用户**单点某一行**单独触发（组件的 pin），不必先整体换层：
 * 展开这一行的结果与 4 级那一行长得一样（用户 2026-10-11 口径："展开就还是第 4 层"）。
 *
 * **第 5 层 = 单条工具/思考的正文（内容），不在级别里**（`TURN_DETAIL_LAYER`）：
 * 一轮几十个事件、每个几百行，整体展开就"一屏放不下两轮"。那份内容只由用户
 * **点开某一行**自己决定（组件的 pin），级别按钮碰不到它。
 */
export type TurnLevel = 1 | 2 | 3 | 4;

export const TURN_LEVEL_MIN = 1;
export const TURN_LEVEL_MAX = 4;

/** 第 5 层：单条工具/思考的**内容**。刻意不在级别循环里（太庞大），只由用户点那行自己开 */
export const TURN_DETAIL_LAYER = 5;

/** 默认级别：3（紧凑过程）—— 打开会话就能读到结论、也看得见过程轮廓 */
export const DEFAULT_TURN_LEVEL: TurnLevel = 3;

export function isTurnLevel(v: unknown): v is TurnLevel {
    return v === 1 || v === 2 || v === 3 || v === 4;
}

/** 循环：1→2→3→4→1（**只给顶部全局按钮用**） */
export function cycleTurnLevel(level: TurnLevel): TurnLevel {
    return (level >= TURN_LEVEL_MAX ? TURN_LEVEL_MIN : level + 1) as TurnLevel;
}

/**
 * 单轮的级别：**只有两态**（收拢 = 1，展开 = 跟全局）。
 *
 * 用户 2026-10-11 口径：级别循环只归顶部那个按钮，**单条信息不做循环** ——
 * 点轮次头就是"把我这条展开 / 收拢"。
 *
 * `mark` 是三态，缺一不可：
 *   · `true`  —— 用户收拢了这一轮（恒 1）
 *   · `false` —— 用户展开了这一轮（跟全局；全局为 1 时给到 2 —— 那一级本来就什么都没展开，
 *     点了必须看得见变化，否则点一下毫无反应，像坏了）
 *   · `undefined` —— 没动过：**完全跟全局**。缺了它，全局按成 1（整体全收缩）时
 *     每一轮都会"因为'展开'而后退到 2"，等于按钮失灵。
 */
export function levelOfTurn(mark: boolean | undefined, global: TurnLevel): TurnLevel {
    if (mark === true) return TURN_LEVEL_MIN;
    if (mark === false) return global > TURN_LEVEL_MIN ? global : 2;
    return global;
}

/** 级别名（给 aria / tip 用；界面上不写死文案，改级别只改这里） */
export function turnLevelLabel(level: TurnLevel): string {
    if (level === 1) return "摘要结论";
    if (level === 2) return "完整结论";
    if (level === 3) return "紧凑过程";
    return "全部展开";
}

/** 顶部**全局**按钮的说明（它才负责换层） */
export function turnLevelTip(level: TurnLevel): string {
    return `所有轮次展开级别 ${level}/${TURN_LEVEL_MAX}（${turnLevelLabel(level)}）· 点击整体换一层（第 ${TURN_DETAIL_LAYER} 层「单条工具/思考的内容」点那一行自己开，不在循环里）`;
}

/** 轮次头（单轮收拢 / 展开）的说明 —— 单条不换层，别让 tip 也写成"下一级" */
export function turnFoldTip(open: boolean): string {
    return open ? "点击收拢这一轮（只留结论摘要）" : "点击展开这一轮（按顶部那个级别显示）";
}

/** 每一级"看得见什么"（组件据此渲染，判断只此一处） */
export interface LevelPlan {
    /** 结论（末条助理正文）**压成 N 行摘要** —— 1 级压、2 级起全文 */
    conclusionClamped: boolean;
    /** 中间区可见（紧凑行）—— 3 级起 */
    mid: boolean;
    /** 紧凑行铺开成逐条 —— 4 级（用户单点某一行也能只展开它自己） */
    midExpanded: boolean;
}

export function planOfLevel(level: TurnLevel): LevelPlan {
    return {
        conclusionClamped: level <= TURN_LEVEL_MIN,
        mid: level >= 3,
        midExpanded: level >= 4,
    };
}

/**
 * 按可视行数截断正文（**1 级「摘要结论」**的摘要态；Markdown 不解析时也走这里）。
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
