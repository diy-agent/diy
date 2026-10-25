// src/shared/context/select-kept-boundary.ts
// 🎯 「按上限算保留边界」—— **唯一实现点**（##432 刀 2，2026-10-25 从 ##423 的临时代管接管）。
//
// 调用方：真实压缩（`history-limit.ts::selectCompactableRange` 的适配层）+ 范例预览
// （`compact-example.ts`，##423 块 3）。两份判据必然漂移，而用户要的正是「示例 = 真实行为」。
// 🚫 不许在别处再写一份累加 / 配平逻辑。
//
// 判据（用户 2026-10-25 口径）：
//   ① 保头：从第一条起装到 ≥ 600 token 为止（**硬编码、不进配置、不参与累加**）；
//   ② 从最后一步往前累加 token，**先判再加** —— 放不下就停在那组之前；
//      尾部总目标 = 上限 × 保留比例（见 `RETAIN_RATIO` 的注释），**保留段总量 ≤ 上限**；
//   ③ 切点必须 tool 配对平衡：留了 result 就必须留下它的 call（整组前移，可连续前移）；
//   ④ 没有可丢的 ⇒ `cut = headEnd + 1`（调用方据此判「什么都没发生」）。
//
// 纯函数：禁止 import node:*（跨层复用：core / UI / 单测）。

/** 边界计算只需要「多大」与「工具配对 / 哪一步」，不绑定具体消息类型 */
export interface BoundaryMessage {
    /** 该条消息的估算 token 数 */
    tokens: number;
    /** `call` / `result` 成对；其余（正文 / user）不用管 */
    kind?: string;
    /** 工具调用与结果共用的 id */
    callId?: string;
    /**
     * 属于哪一步（可选）：有它时**按 step 组**从尾往前累加（用户口径「从后往前数 step」）；
     * 缺省 = 每条自成一组（UI 范例预览只关心大小，不必编 step）。
     */
    step?: string;
}

export interface KeptBoundary {
    /** 保头区最后一条的下标（-1 = 没有保头） */
    headEnd: number;
    /** 尾部保留区的起点下标；`messages.length` = 尾部一条都不取（上限 0 的情形） */
    cut: number;
}

/** 保头（token）—— 硬编码 600，不进配置 */
export const HEAD_KEEP_TOKENS = 600;

/**
 * **保留比例**（硬编码）：一次压缩只把历史保留到上限的这么点，余下的额度留给后续新增。
 *
 * 为什么必须有它（##432 review A）：若压缩只压到「刚好 ≤ 上限」，**每新增一步就重新超限** ⇒
 * 每步都算一次切点、每步写一条 compaction entry、前缀缓存每步被打断 —— 与「压缩是罕见事件」
 * 正面相反。留一半 ⇒ 要涨回上限才再压一次。
 *
 * 注意它同时也是「保守」的旋钮：`retain = limit × ratio` 才是尾部真正能装的量，
 * 所以**保留段 ≤ limit 恒成立**（更强的一条硬约束，见单测）。
 */
export const RETAIN_RATIO = 0.5;

/** 把切点往前挪到 tool 配对平衡处：留了 result 就必须留它的 call（可连续前移） */
function balanceCut(messages: readonly BoundaryMessage[], cut: number, headEnd: number): number {
    let c = cut;
    for (let guard = 0; guard < messages.length && c > headEnd; guard++) {
        if (c >= messages.length) return c; // 尾部一条都没取（全在保头里）
        const m = messages[c]!;
        if (m.kind !== "result" || !m.callId) return c;
        const callIdx = messages.findIndex((x) => x.kind === "call" && x.callId === m.callId);
        if (callIdx < 0 || callIdx >= c) return c;
        c = callIdx;
    }
    return c;
}

/**
 * 按 **step** 切组：同 step 的连续消息成组，**没有 step 的每条自成一组**（UI 范例预览不编 step，
 * 也要能按条切）。返回每组的起始下标（升序，首项恒 0）。
 */
function groupStarts(messages: readonly BoundaryMessage[]): number[] {
    const starts: number[] = [0];
    let prev = messages[0]?.step ?? "";
    for (let i = 1; i < messages.length; i++) {
        const key = messages[i]!.step ?? "";
        if (key === "" || key !== prev) starts.push(i);
        prev = key;
    }
    return starts;
}

/**
 * 按上限算保留边界（**唯一判据**）。
 *
 * @param messages 消息序列（只需 `tokens` / 工具配对 / 可选 `step`）
 * @param budgetTokens 上限（token；`<= 0` = 清零：只留保头）
 */
export interface BoundaryOpts {
    /** 保头 token（缺省 `HEAD_KEEP_TOKENS`；单测可传更小的值，**不改变真实行为的缺省**） */
    headTokens?: number;
    /** 保留比例（缺省 `RETAIN_RATIO`；同样只给单测用） */
    retainRatio?: number;
}

export function selectKeptBoundary(
    messages: readonly BoundaryMessage[],
    budgetTokens: number,
    opts: BoundaryOpts = {},
): KeptBoundary {
    const headKeep = opts.headTokens ?? HEAD_KEEP_TOKENS;
    const ratio = opts.retainRatio ?? RETAIN_RATIO;
    const n = messages.length;
    // ① 保头：装到 ≥ HEAD_KEEP_TOKENS 为止
    let headEnd = -1;
    let headTokens = 0;
    for (let i = 0; i < n; i++) {
        if (headTokens >= headKeep) break;
        headTokens += messages[i]!.tokens;
        headEnd = i;
    }
    if (n === 0) return { headEnd: -1, cut: 0 };

    // ② 清零：尾部一条都不取
    if (!(budgetTokens > 0)) return { headEnd, cut: n };

    // 尾部可用额度 = 保留目标（上限 × 比例）− 保头已占
    const tailBudget = Math.max(0, Math.floor(budgetTokens * ratio) - headTokens);

    const starts = groupStarts(messages);
    const groupCost = (g: number): number => {
        const from = starts[g]!;
        const to = g + 1 < starts.length ? starts[g + 1]! : n;
        let c = 0;
        for (let i = from; i < to; i++) c += messages[i]!.tokens;
        return c;
    };

    // 最后一组**永远至少保留**（不能一条都不留）
    let acc = groupCost(starts.length - 1);
    let g = starts.length - 2;
    for (; g >= 0; g--) {
        const c = groupCost(g);
        if (acc + c > tailBudget) break; // 先判再加：放不下 ⇒ 停在这一组之前
        acc += c;
    }
    if (g < 0) return { headEnd, cut: headEnd + 1 }; // 全部装得下 ⇒ 什么都没发生

    let cut = starts[g + 1]!;
    if (cut <= headEnd) return { headEnd, cut: headEnd + 1 }; // 没有可丢的
    cut = balanceCut(messages, cut, headEnd);
    if (cut <= headEnd) return { headEnd, cut: headEnd + 1 };
    return { headEnd, cut };
}

/** 保留段（保头 + 尾部）是否真的丢了一条以上 —— 调用方判「这次是不是事件」 */
export const hasDropped = (b: KeptBoundary, n: number): boolean => b.cut > b.headEnd + 1 && b.cut < n;
