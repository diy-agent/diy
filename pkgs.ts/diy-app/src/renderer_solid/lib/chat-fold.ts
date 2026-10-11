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
 *   ③ 活动块 `liveTailOf` + 插入位置 `liveSlotIndex` —— 只有直播轮次有（**就地**画在中间区里）
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

// ─── 3 级起的中间区：正文逐条 + 连续过程折成一行 ──────────────

/** 3 级起「中间区」的一项（文档序） */
export type ContentItem =
    | { kind: "user"; key: string; node: BlockNode }
    | { kind: "error"; key: string; node: BlockNode }
    | { kind: "text"; key: string; node: BlockNode }
    | { kind: "proc"; key: string; parts: BlockNode[] };

/**
 * 3 级起的中间区（**严格文档序，不重排**）。
 *
 * 用户 2026-10-11 第四次口径（推翻上一版的"紧凑行"）：
 *   ① **助理正文一律各自成项、全文显示**（"3 级不折叠 text"）—— 上一版把"过程 +
 *      收束它的那条正文"压成一行，收起时显示的是**正文首行**、展开后那条正文却排在
 *      工具**后面**，与文档序（思考 → 正文）眼见的顺序相反（用户实测："思考->文本，
 *      但折叠时显示的是文本，展开文本却跑到后面"）。
 *   ② **连续的思考/工具折成一行 bar**：bar 左侧写这一段**第一个**过程的内容、
 *      右侧是思考数 / 工具数（`💭 n · ⚙ n`）；点它展开成逐条单行（= 第 4 级那一行）。
 *
 * 为什么这样切就绕开了顺序问题：正文与过程**各按文档序先后成项，没有任何"合并"**
 * —— 合并在哪，顺序就在哪出问题（上一版的教训）。bar 只含过程，它落在哪一行
 * 就是那些过程在时间线上的位置。
 *
 * 单独成项、不进 bar 的三种：
 *   · 用户发言（含插话）—— 脉络本体，且必须就地（提前 = 又一次重排）
 *   · error 块 —— 收进 bar 就看不见了（一轮报错后与成功轮次长得一样 = 信息丢失）
 *   · 助理正文（含结论）—— 这一轮"说了什么"的正文，全文可见，不压不并
 *
 * 轮首用户发言由调用方先画（见 leadUsers），此处排除，避免同一句画两遍。
 * `skip` 给调用方剔除**活动块那一个节点** —— 它要带定高展开体单独画，留在文档序里就是
 * 同一块画两遍（2026-10-04 review P1-1）。位置由 `liveSlotIndex` 补回（插回文档序原位）。
 */
export function contentItems(turn: BlockNode, skip?: (n: BlockNode) => boolean): ContentItem[] {
    const lead = new Set(leadUsers(turn));
    const out: ContentItem[] = [];
    let parts: BlockNode[] = []; // 连续的过程叶子（think/tool/plan…），文档序
    const flush = () => {
        // 空段不出：`skip` 剔掉实时区那一个节点后，一段可能整个空了
        if (parts.length) out.push({ kind: "proc", key: parts[0]!.id, parts });
        parts = [];
    };
    for (const n of leavesOf(turn)) {
        if (lead.has(n) || skip?.(n)) continue;
        if (isUserText(n)) {
            flush();
            out.push({ kind: "user", key: n.id, node: n });
        } else if (n.tag === "error") {
            flush();
            out.push({ kind: "error", key: n.id, node: n });
        } else if (n.tag === "text") {
            flush();
            out.push({ kind: "text", key: n.id, node: n });
        } else {
            // 过程块攒着 —— 连续的过程在界面上就是一行的 bar（见上）
            parts.push(n);
        }
    }
    flush();
    return out;
}

/**
 * 直播轮次的**活动过程** = 最后一个过程叶子（think / tool）；还没有过程块（刚发出去、
 * 模型连第一个 think 都还没产出）→ null，那段时间交给"等待响应"的 loading。
 *
 * ⚠️ 判据**故意不看它后面还有什么**（旧版规则③"后面有助理正文就让位"已删）：
 *   一条正文开始流就让位，等于把刚跑完那个工具**从框里搬回文档序的 bar 里** ——
 *   框消失 + 同一块内容换容器 = 双重跳变；而 3 级的 bar 是折叠的，那段工具输出当场看不见
 *   （用户 2026-10-11："遇到一个 text 消息时，动态输出的文本框会消失…视觉跳动"）。
 *   现在活动块**就地**画（位置见 `liveSlotIndex`），正文只是在它下方原地往下长 ——
 *   不换容器、不搬家。
 *
 * `stopped` 两态由渲染侧判定（同一个判据，不再另开字段）：未定稿 = 在跑（体里实时刷）；
 * 已定稿但还没被下一步替换掉 = **冻结**（标题栏转 `⋯ 等待下一步…`，内容留在框里）。
 * 用户口径（2026-10-11）："step 完成后不要立即消失 … 直到下一步开始接收时替换掉当前
 * 最后一条，避免长时间空白期"。
 */
export function liveTailOf(turn: BlockNode, isLive: boolean): BlockNode | null {
    if (!isLive) return null;
    const procs = leavesOf(turn).filter(isProc);
    return procs[procs.length - 1] ?? null;
}

/**
 * 活动块**该插在中间区的第几项之前**（`contentItems` 已把它 skip 掉，位置得补回来）。
 *
 * 为什么必须补：活动块是"最后一个过程叶子"，但它后面**可能还有东西** —— 最常见的就是
 * 收尾那条正文（think → tool → 正文 是标准时序）。挂在列表末尾就会排到那条正文**后面**，
 * 与文档序相反（顺序一错用户一眼看得出来，2026-10-04 那个坑）。
 * 判据 = 文档序位置：数一数前面有几项，其**首个叶子**排在活动块之前。
 * 取不到（节点已被移除）→ 排在末尾，宁可偏后也不要抛错。
 */
export function liveSlotIndex(turn: BlockNode, items: ContentItem[], node: BlockNode): number {
    const order = new Map<string, number>();
    leavesOf(turn).forEach((n, i) => order.set(n.id, i));
    const at = order.get(node.id) ?? Number.POSITIVE_INFINITY;
    let i = 0;
    while (i < items.length && (order.get(items[i]!.key) ?? Number.POSITIVE_INFINITY) < at) i++;
    return i;
}

// ─── 展开级别 ────────────────────────────────────────

/**
 * 轮次展开级别（像 JSON 树那样一层比一层细）。
 *
 * 2026-10-11 用户口径（第四次修正）：
 *   1 摘要结论 —— 轮次头 + 末条助理正文，**压成 N 行摘要**（底部渐隐 + "还有 N 行"提示行）
 *   2 完整结论 —— 轮次头 + 末条正文**全文**（其余仍不显示）
 *   3 全部正文 —— + 中间区：**助理正文逐条全文**，连续的过程折成一行 bar（见 contentItems）
 *   4 逐条过程 —— 过程 bar 铺开成"每事件一行"（正文同 3 级）
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

/** 默认级别：3（全部正文）—— 打开会话就能读到正文、也看得见过程轮廓 */
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
    if (level === 3) return "全部正文";
    return "逐条过程";
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
    /** 中间区可见（正文逐条 + 过程 bar）—— 3 级起 */
    mid: boolean;
    /** 过程 bar 铺开成逐条 —— 4 级（用户单点某一行也能只展开它自己） */
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
