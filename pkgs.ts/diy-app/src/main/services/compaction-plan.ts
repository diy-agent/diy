// src/main/services/compaction-plan.ts
// 🎯 压缩选择：**元件库 + 装配器**（纯函数；只 `import type`，无运行时依赖 local-blocks）
//
// ── 为什么要拆（用户 2026-10-08）──
// 「用**一个固定算法**达成『什么该留』的一致性认同」在信息论上不可达：重要性是**任务相关**的，
// 类型优先级（user > 结论 > …）与时近性（最近几次操作）是**两个正交维度**，压成一维必然丢信息。
// 所以把算法从「决策者」降级为「默认 + 兜底」，把决策上移：**机制保证不变量（配对铁律 / 预算 /
// 注记），策略交给装配**。本文件即那套「机制」——经过测试的**挑选元件** + 一个把元件装成管道的**装配器**。
//
// ── 与存储的关系（务必守住）──
// 本轮**不动任何存储结构**：`auto-compact.yaml` 的 policy 形状、`.compact.jsonl` 的事件形状一律不变。
// 默认管道由 `defaultBudgetPlan()` **人工定义**、复刻旧算法（`HISTORY_LADDER` 纵向阶梯）之行为 ⇒
// 交付侧逐字节不变。第二轮再让「装配规则」进配置、由 agent 组合（那时才碰存储）。
//
// ── 概念 ──
//   Picker（元件）  —— 产出**有序**候选消息下标（越前越先被考虑）；不管预算。
//   PickStage（级） —— 一个元件 + 它的预算处理（count 计入预算 / exempt 托底不计）。
//   CompactPlan（管道）—— 有序若干级 + 总预算。
//   装配 = 把挑选元件排成级；执行 = `runPlan` 逐级累加（本文件）。
//
// 不变量（无论怎么装配都成立，由 `runPlan` 强制）：
//   · tool-call 与其 tool-result **同进退**（配对铁律）；result 从不单独入选（无孤儿）。
//   · `exempt` 级不消耗预算（托底底盘：如「最近 N 条完整工具历史」）。
//   · 结果永远给「升序 kept + 连续区间 keptRuns + 渲染后字节 keptBytes」。

import type { LocalModelMessage } from "./local-blocks";

// ─── 分类（纵向阶梯；系统定义、只读可见）──────────────────────────

/** 消息在阶梯里的类别（数组序 = 优先级，前 = 高） */
export type HistoryRank = "user" | "conclusion" | "text" | "call" | "result";

/**
 * 优先级阶梯：**系统定义、只读可见**（不给用户拧）。
 *   user       = 用户发言（主干）
 *   conclusion = 助手**结论**文本（每轮最后一条助手文本）
 *   text       = 助手非结论文本（过程性："我先看看…"）
 *   call       = 工具命令（tool-call）
 *   result     = 工具结果（content）
 */
export const HISTORY_LADDER: readonly HistoryRank[] = ["user", "conclusion", "text", "call", "result"];

const RANK_OF: Record<HistoryRank, number> = { user: 0, conclusion: 1, text: 2, call: 3, result: 4 };

/** 消息是否是 tool-call（携带 tool-call part） */
export function hasToolCall(m: LocalModelMessage): boolean {
    return Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call");
}

/** tool-call 消息的 toolCallId（不是 tool-call → null） */
export function callIdOfMessage(m: LocalModelMessage): string | null {
    if (!hasToolCall(m)) return null;
    const c = (m.content as { type: string; toolCallId?: string }[]).find((p) => p.type === "tool-call");
    return c?.toolCallId ?? null;
}

/** 选择结果 */
export interface BudgetSelection {
    /** 保留的消息下标（升序）；行号 = 下标 + 1 */
    kept: number[];
    /** 被丢弃的消息下标（升序） */
    dropped: number[];
    /** 保留的**连续区间**（[from,to] 1-based，含两端）—— 索引标注用它（gap = 区间之间的空隙，不必逐 gap 标注） */
    keptRuns: [number, number][];
    /** 实际占用字节（**渲染后**口径，工具结果已按策略裁剪） */
    keptBytes: number;
}

// ─── 装配上下文（一次选择内共用；把「分类 / 配对 / 成本」算一次）──────

export interface PickCtx {
    all: readonly LocalModelMessage[];
    /** 每条消息的阶梯类别 */
    rank: readonly HistoryRank[];
    /** toolCallId → tool-result 消息下标（配对用） */
    resultOf: ReadonlyMap<string, number>;
    /** 每条消息的**投递**字节（渲染后口径；由调用方注入 costOf） */
    cost: readonly number[];
}

/** 一元的**挑选元件**：产出**有序**候选下标（越前越先考虑）。不给预算判断。 */
export interface Picker {
    /** 调试 / 审计用的短名（第二轮进配置时也用它标识元件） */
    label: string;
    /** 产出有序候选下标；可重复（去重由 runPlan 做） */
    picks: (ctx: PickCtx) => Iterable<number>;
}

/** 装配级：一个挑选元件 + 它的预算处理 */
export interface PickStage {
    label: string;
    picker: Picker;
    /** "count" = 计入预算；"exempt" = **托底**（不计预算，如「必带的最近 N 条工具历史」） */
    budget: "count" | "exempt";
    /** 本元件最多取多少个**单元**（unit = call + 其 result 算一个）；缺省不限 */
    limit?: number;
}

/** 装配管道：有序若干级 + 总预算 */
export interface CompactPlan {
    /** 计入预算的级共用的字节上限（exempt 级不受它限制） */
    budgetBytes: number;
    stages: PickStage[];
}

// ─── 分类与排序（纯）──────────────────────────────────────────

/** 给全量投影分类（每轮最后一条助手文本 = 结论） */
export function classify(all: readonly LocalModelMessage[]): HistoryRank[] {
    const n = all.length;
    const lastTextIdx = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const m = all[i]!;
        if (m.role === "assistant" && !hasToolCall(m)) lastTextIdx.set(m.turn ?? "", i);
    }
    const rank = new Array<HistoryRank>(n);
    for (let i = 0; i < n; i++) {
        const m = all[i]!;
        if (m.role === "user") rank[i] = "user";
        else if (m.role === "tool") rank[i] = "result";
        else if (hasToolCall(m)) rank[i] = "call";
        else rank[i] = lastTextIdx.get(m.turn ?? "") === i ? "conclusion" : "text";
    }
    return rank;
}

/** toolCallId → tool-result 下标（跨整份投影；配对铁律的依据） */
export function pairToolResults(all: readonly LocalModelMessage[]): Map<string, number> {
    const resultOf = new Map<string, number>();
    for (let i = 0; i < all.length; i++) {
        const m = all[i]!;
        if (m.role !== "tool") continue;
        for (const p of m.content as { type: string; toolCallId?: string }[]) {
            if (p.type === "tool-result" && p.toolCallId) resultOf.set(p.toolCallId, i);
        }
    }
    return resultOf;
}

/** 构造装配上下文（分类 + 配对 + 成本）—— 成本由调用方注入（渲染口径归 local-blocks） */
export function buildCtx(all: readonly LocalModelMessage[], costOf: (m: LocalModelMessage) => number): PickCtx {
    return {
        all,
        rank: classify(all),
        resultOf: pairToolResults(all),
        cost: all.map((m) => costOf(m)),
    };
}

// ─── 元件（Picker）构造器 ──────────────────────────────────────

/**
 * **纵向阶梯**（现役默认）：按类别优先级升序、**同层新的先**（下标降序）。
 * 这是 ##271 目标式压缩的排序；拆出来后作为「默认管道」的唯一一级。
 */
export const byLadder = (): Picker => ({
    label: "ladder",
    picks: (ctx) =>
        Array.from({ length: ctx.all.length }, (_, i) => i).sort(
            (a, b) => RANK_OF[ctx.rank[a]!] - RANK_OF[ctx.rank[b]!] || b - a,
        ),
});

/**
 * **最近 N 条消息**（新的先）—— 可选按角色过滤。
 * 例：`recentMessages(12, { role: "tool" })` = 最近 12 条工具消息（托底底盘常用）。
 */
export const recentMessages = (count: number, opts: { role?: LocalModelMessage["role"] } = {}): Picker => ({
    label: `recent:${count}${opts.role ? `:${opts.role}` : ""}`,
    picks: (ctx) => {
        const out: number[] = [];
        for (let i = ctx.all.length - 1; i >= 0 && out.length < count; i--) {
            if (opts.role && ctx.all[i]!.role !== opts.role) continue;
            out.push(i);
        }
        return out;
    },
});

/**
 * **最近 N 个 step 的消息**（新的 step 先；同 step 内按原序）。
 * 只取有 `step` 索引位的消息（开场 user / 插话无 step，由角色元件负责）。
 * 供「必带的最近几步完整历史」这类托底盘使用。
 */
export const recentSteps = (count: number): Picker => ({
    label: `steps:${count}`,
    picks: (ctx) => {
        const byStep = new Map<string, number[]>();
        const recency: string[] = [];
        for (let i = 0; i < ctx.all.length; i++) {
            const s = ctx.all[i]!.step;
            if (!s) continue;
            if (!byStep.has(s)) {
                byStep.set(s, []);
                recency.push(s);
            }
            byStep.get(s)!.push(i);
        }
        const out: number[] = [];
        for (const s of recency.slice(-count).reverse()) out.push(...byStep.get(s)!);
        return out;
    },
});

// ─── 装配（把元件组成级 / 管道）───────────────────────────────

/** 计入预算的一级 */
export const stage = (picker: Picker, opts: { limit?: number } = {}): PickStage => ({
    label: picker.label,
    picker,
    budget: "count",
    limit: opts.limit,
});

/** **托底**一级（不计预算）：如「必带的最近 N 条工具完整历史」 */
export const exemptStage = (picker: Picker, opts: { limit?: number } = {}): PickStage => ({
    label: `${picker.label}!`,
    picker,
    budget: "exempt",
    limit: opts.limit,
});

/** 装配一条管道 */
export const plan = (budgetBytes: number, ...stages: PickStage[]): CompactPlan => ({ budgetBytes, stages });

/**
 * **默认管道**（人工定义，复刻 ##271 目标式预算的既有行为）：单级 = 纵向阶梯 + 计入预算。
 * ⚠️ 它就是「人」现在装配的那条；第二轮由 agent 组合其它管道，行为从此可插拔。
 */
export const defaultBudgetPlan = (budgetBytes: number): CompactPlan => plan(budgetBytes, stage(byLadder()));

// ─── 执行（装配器）────────────────────────────────────────────

/**
 * 执行一条管道 → 保留哪些下标（纯函数）。
 *
 * 逐级累加：每级按元件给的有序候选依次尝试；**call 与其 result 同进退**（不够就一起丢），
 * result 从不单独入选。`count` 级受 `budgetBytes` 约束（放不下则跳过该候选、继续试后面的）；
 * `exempt` 级不计预算。同级内 `limit` 限单元数。重复候选自动去重（已入选则跳过）。
 *
 * ⚠️ 与旧算法**逐字节等价**（默认管道下）：见 tests/core/compaction-budget.test.ts。
 */
export function runPlan(
    all: readonly LocalModelMessage[],
    p: CompactPlan,
    args: { costOf: (m: LocalModelMessage) => number },
): BudgetSelection {
    const n = all.length;
    if (n === 0) return { kept: [], dropped: [], keptRuns: [], keptBytes: 0 };

    const ctx = buildCtx(all, args.costOf);
    const keep = new Array<boolean>(n).fill(false);
    let remaining = Math.max(0, p.budgetBytes);

    for (const st of p.stages) {
        let units = 0;
        for (const i of st.picker.picks(ctx)) {
            if (keep[i]) continue;
            if (ctx.rank[i] === "result") continue; // 结果只随其 call 一起选
            if (st.limit !== undefined && units >= st.limit) break;

            const add: number[] = [i];
            let c = ctx.cost[i]!;
            if (ctx.rank[i] === "call") {
                const id = callIdOfMessage(all[i]!);
                const ri = id !== null ? ctx.resultOf.get(id) : undefined;
                if (ri !== undefined && !keep[ri]) {
                    add.push(ri);
                    c += ctx.cost[ri]!;
                }
            }

            if (st.budget === "count") {
                if (c > remaining) continue; // 放不下 → 跳过该候选（后面的可能更小）
                for (const k of add) {
                    keep[k] = true;
                    remaining -= ctx.cost[k]!;
                }
            } else {
                for (const k of add) keep[k] = true; // 托底：不计预算
            }
            units++;
        }
    }

    // 汇总：升序 kept + 连续区间 + 渲染后字节
    const kept: number[] = [];
    const dropped: number[] = [];
    for (let i = 0; i < n; i++) (keep[i] ? kept : dropped).push(i);
    const keptRuns: [number, number][] = [];
    let prev = -2;
    let keptBytes = 0;
    for (const i of kept) {
        keptBytes += ctx.cost[i]!;
        if (i === prev + 1) keptRuns[keptRuns.length - 1]![1] = i + 1;
        else keptRuns.push([i + 1, i + 1]);
        prev = i;
    }
    return { kept, dropped, keptRuns, keptBytes };
}
