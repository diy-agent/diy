// src/shared/context/history-limit.ts
// 🎯 **唯一的压缩算法**（##432 刀 2）：一条上限 + 从后往前数 step + 保头 600 token。
//
// 删掉的东西（用户 2026-10-25 拍板）：`ladder / role / recent / steps` 四级取法、
// `must`（不占预算）、`budgetBytes` 多级挑拣、`clip` 策略矩阵 —— 那些让人连作者自己都看不懂，
// 且 `must` 不占预算导致「压完还超预算」。现在的规则只有一条：
//
//   从最后一步往前累加 token（字符数 / 4 的粗估），装得下就装，装不下就停；
//   切点必须 tool 配对平衡（不平衡就往前挪）；**保头 600 token 硬编码**（不参与累加、永不被丢）。
//
// 「边界只在压缩事件时算一次并落盘」——算一次的入口就是这里的 `selectCompactableRange`，
// 落盘与之后的每步追加由 `@diy/persistence` / `local-agent` 负责（本文件是**纯函数**，禁止 node:*）。

import { z } from "zod";

/**
 * 保头 token 数（**硬编码，不进配置**）：首个 user / 任务目标所在的开头永远不参与累加、永不被丢。
 * 用户口径：「保头 600 token 硬编码（不进配置、不参与累加）」。
 */
export const HISTORY_HEAD_TOKENS = 600;

/**
 * **保留比例**（硬编码，不进配置）：一次压缩只把历史保留到上限的这么点，余下的留给后续新增。
 *
 * 为什么必须有它（##432 review A）：若压缩只压到「刚好 ≤ 上限」，**每新增一步就重新超限** ⇒
 * 每步都算一次切点、每步写一条 compaction entry、前缀缓存每步被打断 —— 与「压缩是罕见事件」
 * 正面相反。留一半 ⇒ 要涨回上限才再压一次（上限 20000 时约 8~10 步一次）。
 */
export const HISTORY_RETAIN_RATIO = 0.5;

/** 单条上限的缺省值（token）。旧 `budgetBytes: 20480` ≈ 5120 token —— 新口径放开到 20000。 */
export const DEFAULT_HISTORY_LIMIT_TOKENS = 20_000;

/**
 * 历史预算的配置面（唯一的一项）。
 *
 * `summary.enabled` 缺省 **false**：v1 **不做摘要 LLM 调用**，丢掉的部分靠注记一行 + ref 指回去查。
 * 留这个开关是为了将来抄 checkpoint 摘要时打开（而不是现在就多一条花钱的路径）。
 */
export const HistoryLimitSchema = z.object({
    limitTokens: z
        .number()
        .describe("历史消息可占的 **token** 上限（字符数 / 4 粗估）：从最后一步往前累加，装得下就装，装不下就停"),
    summary: z
        .object({
            enabled: z.boolean().describe("是否对丢掉的那段做摘要（v1 缺省 false：只留一行注记 + ref 指回原文）"),
        })
        .describe("摘要开关"),
});

export type HistoryLimit = z.infer<typeof HistoryLimitSchema>;

export const DEFAULT_HISTORY_LIMIT: HistoryLimit = {
    limitTokens: DEFAULT_HISTORY_LIMIT_TOKENS,
    summary: { enabled: false },
};

/** 宽松归一：手写 / LLM 写的配置可能缺字段、给成 0 / 负数 / 旧字段名 */
export function normalizeHistoryLimit(raw: unknown): HistoryLimit {
    const src = (raw ?? {}) as Record<string, unknown>;
    const n = src["limitTokens"];
    const limitTokens = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_HISTORY_LIMIT_TOKENS;
    const sum = src["summary"] as Record<string, unknown> | undefined;
    return { limitTokens, summary: { enabled: sum?.["enabled"] === true } };
}

/** token 粗估：**字符数 / 4**（不做 meter —— 精确计量要 tokenizer，且每步付一次代价不值得） */
export function estimateTokensOf(text: string): number {
    // 用 UTF-16 长度近似字符数：中文 1 字 ≈ 1 token 的量级，英文 1 词 ≈ 2 字符 → 两者都在这个粗估里可接受
    return Math.ceil(text.length / 4);
}

/** 算法只需要这几样（不绑 LocalModelMessage，便于单测与跨层复用） */
export interface CompactableMessage {
    role: string;
    content: unknown;
    /** 属于哪一步（缺省 = 开场 user / 无步消息，归到前一个组） */
    step?: string;
}

export interface CompactableRange {
    /** 切点的消息下标（**这条及之后保留**；它之前的非保头部分被丢弃） */
    cut: number;
    /** 保头结束的下标（`[0, headEnd)` 永远保留） */
    headEnd: number;
    /** 本次丢掉的消息条数（不含保头） */
    dropped: number;
}

const toolCallIds = (m: CompactableMessage): string[] => {
    if (!Array.isArray(m.content)) return [];
    return (m.content as { type?: string; toolCallId?: string }[])
        .filter((p) => p.type === "tool-call" && typeof p.toolCallId === "string")
        .map((p) => p.toolCallId!);
};

const toolResultIds = (m: CompactableMessage): string[] => {
    if (!Array.isArray(m.content)) return [];
    return (m.content as { type?: string; toolCallId?: string }[])
        .filter((p) => p.type === "tool-result" && typeof p.toolCallId === "string")
        .map((p) => p.toolCallId!);
};

/**
 * 按 **step** 把消息切成若干连续组：同 step 的消息成组；没有 step 的消息**并入前一组**
 * （开场 user 属于它后面那一轮的第一步）。返回每组的起始下标（升序，首项恒为 0）。
 */
export function stepStarts(all: readonly CompactableMessage[]): number[] {
    const starts: number[] = [];
    let prev = "";
    for (let i = 0; i < all.length; i++) {
        const key = all[i]!.step ?? "";
        if (i === 0) {
            starts.push(0);
            prev = key;
            continue;
        }
        if (key !== "" && key !== prev) starts.push(i);
        if (key !== "") prev = key;
    }
    return starts;
}

/** `[cut, end)` 里有没有「其 tool-call 在 cut 之前」的 result（= 切开了配对） */
function splitsToolPair(all: readonly CompactableMessage[], cut: number): boolean {
    if (cut <= 0) return false;
    const callsBefore = new Set<string>();
    for (let i = 0; i < cut; i++) for (const id of toolCallIds(all[i]!)) callsBefore.add(id);
    if (callsBefore.size === 0) return false;
    for (let i = cut; i < all.length; i++) for (const id of toolResultIds(all[i]!)) if (callsBefore.has(id)) return true;
    return false;
}

/** `[0, cut)` 里有没有「其 result 在 cut 之后」的 tool-call（同一个判据的另一侧） */
function hasUnansweredCallBefore(all: readonly CompactableMessage[], cut: number): number | null {
    const resultsAfter = new Set<string>();
    for (let i = cut; i < all.length; i++) for (const id of toolResultIds(all[i]!)) resultsAfter.add(id);
    if (resultsAfter.size === 0) return null;
    for (let i = 0; i < cut; i++) for (const id of toolCallIds(all[i]!)) if (resultsAfter.has(id)) return i;
    return null;
}

export interface SelectRangeOpts {
    /** 每条消息的 token 成本（缺省 = 渲染后 JSON 字符数 / 4） */
    costOf?: (m: CompactableMessage, index: number) => number;
    /** 保头 token（缺省 `HISTORY_HEAD_TOKENS`；单测可传更小的值） */
    headTokens?: number;
}

/**
 * **唯一的切点算法**（照抄 dsh 的 `selectCompactableRange`，见 `~/git-ref/deepseek-harness/packages/compaction/compaction-basic/src/region.ts:110-160`）：
 *
 *   ① 保头：从第 0 条起到累计 ≥ headTokens 为止，这些消息**不参与累加、永不被丢**；
 *   ② 从最后一组（step）往前累加 token，累积 ≥ limitTokens 即停 —— 停处就是切点；
 *   ③ 切点**必须 tool 配对平衡**（不许切开 toolCall 与 toolResult），不平衡就**往前挪**一组；
 *   ④ 切点 ≤ 保头（没有可丢的）⇒ `null`（什么都没发生，不写边界）。
 *
 * 返回值里的 `cut` 是**绝对下标**（相对于传入的 `all`），由调用方换算成 llm 行号后落盘。
 */
export function selectCompactableRange(
    all: readonly CompactableMessage[],
    limitTokens: number,
    opts: SelectRangeOpts = {},
): CompactableRange | null {
    const n = all.length;
    if (n === 0 || !(limitTokens > 0)) return null;
    const cost = opts.costOf ?? ((m: CompactableMessage) => estimateTokensOf(JSON.stringify(m.content ?? "")));
    const headTokens = opts.headTokens ?? HISTORY_HEAD_TOKENS;

    // ① 保头
    let headEnd = 0;
    let headAcc = 0;
    while (headEnd < n && headAcc < headTokens) {
        headAcc += cost(all[headEnd]!, headEnd);
        headEnd += 1;
    }

    // ② 从最后一组往前累加 —— **先判再加**：放不下就停在这一组之前。
    //
    // ⚠️ 「保留段总量 ≤ 上限」是**硬要求**（##432 review A）：dsh 的 `retainTokens` 是「至少保留」的下限
    // （它的触发看窗口比例），而我们只有这一个数 —— 若保留「≥ 上限」，压完总量**恒 > 上限** ⇒ 下一步
    // 又触发 ⇒ 每步压一次（前缀缓存每步被打断 + 账本无限涨）。先判再加 ⇒ 压完 ≤ 上限 ⇒ 下一次必须等
    // 新增把总量重新顶过线，压缩才真正成为**事件**。
    const starts = stepStarts(all);
    const groupCost = (g: number): number => {
        const from = starts[g]!;
        const to = g + 1 < starts.length ? starts[g + 1]! : n;
        let c = 0;
        for (let i = from; i < to; i++) c += cost(all[i]!, i);
        return c;
    };
    let headCost = 0;
    for (let i = 0; i < headEnd; i++) headCost += cost(all[i]!, i);
    // 尾部的可用额度 = **保留目标** - 保头（保留目标 = 上限 × 保留比例，见 HISTORY_RETAIN_RATIO）
    const tailBudget = Math.max(0, Math.floor(limitTokens * HISTORY_RETAIN_RATIO) - headCost);

    let acc = 0;
    let groupIdx = starts.length - 1;
    // 最后一组**永远至少保留**（不能一条都不留）：它自己就超额度时也留它
    const lastCost = groupCost(groupIdx);
    acc = lastCost;
    groupIdx -= 1;
    for (; groupIdx >= 0; groupIdx--) {
        const c = groupCost(groupIdx);
        if (acc + c > tailBudget) break; // 放不下 ⇒ 停在这一组之前
        acc += c;
    }
    if (groupIdx < 0 && acc <= tailBudget) return null; // 全部装得下 ⇒ 不压
    let cut = starts[groupIdx + 1]!;

    // ③ 配对平衡：切开的地方往前挪（挪到最小的一处「答案在后面的 call」之前，再对齐到组起点）
    for (let guard = 0; guard < starts.length + 4; guard++) {
        if (!splitsToolPair(all, cut)) break;
        const bad = hasUnansweredCallBefore(all, cut);
        if (bad === null) break;
        let g = 0;
        while (g + 1 < starts.length && starts[g + 1]! <= bad) g++;
        cut = starts[g]!;
        if (cut <= headEnd) return null;
    }

    // ④ 没有可丢的
    if (cut <= headEnd) return null;
    return { cut, headEnd, dropped: cut - headEnd };
}
