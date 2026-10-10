/**
 * 轮次折叠的**语义**（纯函数，可单测）——组件只负责画。
 *
 * 为什么单独一层：折叠态"显示什么、按什么序"是语义而不是样式，
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
 * 折叠态可见项 —— **严格文档序，不重排**。
 *
 * 历史教训（2026-10-04）：上一版是「全部用户发言 → 实时行 → 最后一条正文」三段拼接。
 * 而插话块在文档序上位于轮次**中间**（用户在第 38 步与第 39 步之间发的），
 * 折叠后它被拽到轮首 → 与它后面那条助理回复的相对顺序颠倒，看着像"助理先说、用户后说"。
 * 现在只做"藏中间过程"，不做"搬位置"：
 *   · 用户发言 —— 恒显（"我说过啥"的脉络本体；插话必须就地）
 *   · error 块 —— 恒显（一轮报错后折叠起来与成功轮次长得一模一样 = 信息丢失）
 *   · 最后一条助理正文 —— 唯一受显示开关（正常/大纲）作用的内容
 *   · 其余（更早的正文、连续过程）一律收起，展开轮次才见
 */
export function foldedItems(turn: BlockNode): BlockNode[] {
    const last = lastAssistantText(turn);
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
