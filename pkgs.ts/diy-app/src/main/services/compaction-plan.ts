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
// 默认管道由 `defaultBudgetPlan()` **人工定义**；##343 M1 起它多了**保底一级**（最近 N 步 `clip: full`，
// 见其注释）—— 这是**行为变更**，不是复刻旧阶梯：旧行为只有「纵向阶梯 + 全局裁」这一档，
// 「保底最近 N 步**字节保真**」在 clip 能力轴落地前物理上做不到。装配规则仍不进配置（M2 再说）。
//
// ── 概念 ──
//   Picker（元件）  —— 产出**有序**候选消息下标（越前越先被考虑）；不管预算。
//   PickStage（级） —— 一个元件 + 它的预算处理（count 计入预算 / exempt 托底不计）+ 可选 `clip`。
//   CompactPlan（管道）—— 有序若干级 + 总预算。
//   装配 = 把挑选元件排成级；执行 = `runPlan` 逐级累加（本文件）。
//
// 不变量（无论怎么装配都成立，由 `runPlan` 强制）：
//   · tool-call 与其 tool-result **同进退**（配对铁律）；result 从不单独入选（无孤儿）。
//   · `exempt` 级不消耗预算（托底底盘：如「最近 N 条完整工具历史」）。
//   · 结果永远给「升序 kept + 连续区间 keptRuns + 渲染后字节 keptBytes」。
//   · **裁剪能力轴**（##343 M1）：每级可声明 `clip`（这条取法取中的消息**怎么裁**），
//     **先选中它的级生效**（先声明者赢）；没声明 ⇒ 回落 `defaultClip`（全局策略的降级）。
//     「保底最近 N 步全量」正是靠它：`exempt` 级 + `clip: full` ⇒ 这 N 步的工具结果字节保真。
//   · **第二条裁剪轴 `reasoningClip`**（##374 T2）：同上语义，管 assistant 消息的**推理文本**。
//     两轴独立（一条消息可以只被声明了推理轴），`reasoningClips` 字段各报各的。

import type { ClipSpec, ReasoningClipSpec } from "../../shared/context/compaction";
import { DEFAULT_EXEMPT_STEPS, DEFAULT_KEEP, type KeepStage } from "../../shared/context/compact-keep";
import type { LocalModelMessage } from "./local-blocks";

export { DEFAULT_EXEMPT_STEPS };

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
    /**
     * 每条消息的**裁法**（下标对齐 `all`；`null` = 没被任何级声明 clip ⇒ 回落 `defaultClip`）。
     * **只在有级声明 clip 时出现** —— 老消费者（与老断言）不必知道这条轴（读侧兼容）。
     */
    clips?: (ClipSpec | null)[];
    /**
     * 每条 assistant 消息的**推理裁法**（##374 T2；下标对齐 `all`；`null` = 没被任何级声明
     * `reasoningClip` ⇒ 回落 `defaultReasoningClip`）。与 `clips` **各自独立**、同样「先选中者赢」——
     * 只是判据按轴走（一条消息可以只被声明了推理轴）。
     * 同样**只在有级声明时出现**（读侧兼容）。
     */
    reasoningClips?: (ReasoningClipSpec | null)[];
}

// ─── 装配上下文（一次选择内共用；把「分类 / 配对 / 成本」算一次）──────

export interface PickCtx {
    all: readonly LocalModelMessage[];
    /** 每条消息的阶梯类别 */
    rank: readonly HistoryRank[];
    /** toolCallId → tool-result 消息下标（配对用） */
    resultOf: ReadonlyMap<string, number>;
    /**
     * 单条消息在**给定裁法**下的投递字节（渲染后口径；由调用方注入）。
     * 必须按 clip 现算而不是预先算一份：保底级 `full` 的字节比裁过的多，算错就是预算算错。
     * 两个轴各自一路（工具结果 / 推理文本，##374 T2）；`reasoningClip` 缺省 `null` ⇒ 渲染侧走全局缺省。
     */
    costOf: (m: LocalModelMessage, clip: ClipSpec | null, reasoningClip?: ReasoningClipSpec | null) => number;
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
    /**
     * 本级取中的消息**怎么裁**（##343 M1 的能力轴）。缺省 = 不声明 ⇒ 回落 `defaultClip`。
     * 一条消息被多级选中时，**先选中它的那一级的 clip 生效**（先声明者赢）——见 runPlan。
     */
    clip?: ClipSpec;
    /**
     * 本级取中的 assistant 消息**推理文本**怎么裁（##374 T2 的第二条裁剪轴）。缺省 = 不声明 ⇒
     * 回落 `defaultReasoningClip`。语义与 `clip` 一致（先选中者赢；两轴独立）。
     */
    reasoningClip?: ReasoningClipSpec;
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
    return all.map((m, i): HistoryRank => {
        if (m.role === "user") return "user";
        if (m.role === "tool") return "result";
        if (hasToolCall(m)) return "call";
        return lastTextIdx.get(m.turn ?? "") === i ? "conclusion" : "text";
    });
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
export function buildCtx(
    all: readonly LocalModelMessage[],
    costOf: (m: LocalModelMessage, clip: ClipSpec | null) => number,
): PickCtx {
    return { all, rank: classify(all), resultOf: pairToolResults(all), costOf };
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
 * **某角色的全部消息**（新的先）—— 例：`byRole("user")` = 用户发言主干。
 * 与 `byLadder` 里 user 那层重叠时用「级」序决定谁先挑（见 runPlan）。
 */
export const byRole = (role: LocalModelMessage["role"]): Picker => ({
    label: `role:${role}`,
    picks: (ctx) => {
        const out: number[] = [];
        for (let i = ctx.all.length - 1; i >= 0; i--) if (ctx.all[i]!.role === role) out.push(i);
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
export const stage = (
    picker: Picker,
    opts: { limit?: number; clip?: ClipSpec; reasoningClip?: ReasoningClipSpec } = {},
): PickStage => ({
    label: picker.label,
    picker,
    budget: "count",
    limit: opts.limit,
    ...(opts.clip ? { clip: opts.clip } : {}),
    ...(opts.reasoningClip ? { reasoningClip: opts.reasoningClip } : {}),
});

/** **托底**一级（不计预算）：如「必带的最近 N 条工具完整历史」 */
export const exemptStage = (
    picker: Picker,
    opts: { limit?: number; clip?: ClipSpec; reasoningClip?: ReasoningClipSpec } = {},
): PickStage => ({
    label: `${picker.label}!`,
    picker,
    budget: "exempt",
    limit: opts.limit,
    ...(opts.clip ? { clip: opts.clip } : {}),
    ...(opts.reasoningClip ? { reasoningClip: opts.reasoningClip } : {}),
});

/** 装配一条管道 */
export const plan = (budgetBytes: number, ...stages: PickStage[]): CompactPlan => ({ budgetBytes, stages });

/** `full` 的规范值（级声明用，避免每处各写一份字面量） */
export const CLIP_FULL: ClipSpec = { type: "full" };

// ─── 配置面 → 可执行管道（##344 M2）────────────────────────────
//
// `history.keep[]`（数据，见 shared/context/compact-keep.ts）→ `CompactPlan`（可执行）。
// 这一层是 M2 的**唯一接缝**：存储/CLI/UI 都只说「级列表」，执行只认 `CompactPlan`。

/** 取法 → 挑选元件（**唯一映射点**；加取法只改这里 + shared 的 schema） */
export function pickerOf(s: KeepStage): Picker {
    switch (s.type) {
        case "ladder":
            return byLadder();
        case "role":
            return byRole(s.data.role);
        case "recent":
            return recentMessages(s.data.n, s.data.role ? { role: s.data.role } : {});
        case "steps":
            return recentSteps(s.data.n);
    }
}

/**
 * 级列表（数据）→ 管道（可执行）。`keep` 缺省 / 空 ⇒ 用 `DEFAULT_KEEP`（= 缺省管道，回落语义）。
 *
 * 预算 **0 = 用户口径的「清零」**（policy 文档明写：「0 = 清零」）：此时**整条管道作废**
 * （含 `must` 级）—— 清零是「这个会话的上下文我全不要了」，保底级不得把它悄悄改写成「留最近 6 步」。
 * 要「留 6 步」就给一个正预算。（与 ##343 M1 的 `defaultBudgetPlan` 同一条口径，故两者在 0 处一致。）
 */
export function keepStagesToPlan(
    keep: readonly KeepStage[] | undefined | null,
    budgetBytes: number,
    /**
     * 工具结果的**全局回落**裁法。⚠️ 本函数**不直接用它**：回落发生在**渲染/计价**侧
     * （`selection.clips[i] == null` ⇒ 用 `DeliveryOpts.defaultClip` / `costOf` 自己的缺省），
     * 留参数只为不动调用方签名（##343 M1 起的既有形状）。
     */
    _defaultClip?: ClipSpec | null,
): CompactPlan {
    if (!(budgetBytes > 0)) return plan(0);
    const specs = keep && keep.length > 0 ? keep : DEFAULT_KEEP;
    return plan(
        budgetBytes,
        ...specs.map((s) => {
            const picker = pickerOf(s);
            const opts = {
                limit: s.limit,
                ...(s.clip ? { clip: s.clip } : {}),
                ...(s.reasoningClip ? { reasoningClip: s.reasoningClip } : {}),
            };
            return s.must ? exemptStage(picker, opts) : stage(picker, opts);
        }),
    );
}

/**
 * **默认管道**（##343 M1 起）—— 现由 `DEFAULT_KEEP`（数据）生成，**单一真源**：
 *   ① `exempt`（不计预算）· `recentSteps(6)` · **`clip: full`** —— 最近 6 步的工具结果**字节保真**；
 *   ② `count`（计预算）· `byLadder` —— 旧消息按全局策略（`defaultClip`）裁（headtail 3/3）。
 *
 * 为什么保底必须 `full`（##340 量尺的结论）：迷路的病灶不是「进度被删」，而是**留下的工具结果
 * 被裁成头尾** —— 只保下标不保字节，等于没保。
 * ⚠️ 它就是「人」现在装配的那条；第二轮起由配置 `history.keep[]` 覆写（M2），行为从此可插拔。
 */
export const defaultBudgetPlan = (budgetBytes: number, defaultClip?: ClipSpec | null): CompactPlan =>
    keepStagesToPlan(DEFAULT_KEEP, budgetBytes, defaultClip);

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
    args: { costOf: (m: LocalModelMessage, clip: ClipSpec | null, reasoningClip?: ReasoningClipSpec | null) => number },
): BudgetSelection {
    const n = all.length;
    if (n === 0) return { kept: [], dropped: [], keptRuns: [], keptBytes: 0 };

    const ctx = buildCtx(all, args.costOf);
    const keep = all.map(() => false);
    /** 每条消息的裁法：**先选中它的那一级**声明什么就是什么（后到的级改不动它） */
    const clips = all.map((): ClipSpec | null => null);
    /** 每条消息的**推理**裁法：与 `clips` 同一条「先选中者赢」，只是两个轴各自记（##374 T2） */
    const rclips = all.map((): ReasoningClipSpec | null => null);
    let declared = false;
    let rDeclared = false;
    let remaining = Math.max(0, p.budgetBytes);

    for (const st of p.stages) {
        let units = 0;
        const clip = st.clip ?? null;
        const rclip = st.reasoningClip ?? null;
        if (clip) declared = true; // 有级声明 ⇒ clips 字段带出（`null` = 该消息没被声明过）
        if (rclip) rDeclared = true; // 同上（推理轴独立；两个字段各自按需带出）
        /** 本级的成本口径（含两个轴的裁法）——成本与渲染必须同源，否则「按 A 算预算、发出去是 B」 */
        const costOf = (i: number): number => ctx.costOf(all[i]!, clip, rclip);
        for (const i of st.picker.picks(ctx)) {
            if (keep[i]) continue; // 已被更前的级选中 ⇒ 连同它的 clip 一起保留（先声明者赢）
            if (ctx.rank[i] === "result") continue; // 结果只随其 call 一起选
            if (st.limit !== undefined && units >= st.limit) break;

            const add: number[] = [i];
            let c = costOf(i);
            if (ctx.rank[i] === "call") {
                const id = callIdOfMessage(all[i]!);
                const ri = id !== null ? ctx.resultOf.get(id) : undefined;
                if (ri !== undefined && !keep[ri]) {
                    add.push(ri);
                    c += costOf(ri);
                }
            }

            if (st.budget === "count") {
                if (c > remaining) continue; // 放不下 → 跳过该候选（后面的可能更小）
                for (const k of add) {
                    keep[k] = true;
                    remaining -= costOf(k);
                }
            } else {
                for (const k of add) keep[k] = true; // 托底：不计预算
            }
            for (const k of add) clips[k] = clip;
            for (const k of add) rclips[k] = rclip;
            units++;
        }
    }

    // 汇总：升序 kept + 连续区间 + 渲染后字节（**按各自生效的 clip** 口径）
    const kept: number[] = [];
    const dropped: number[] = [];
    for (let i = 0; i < n; i++) (keep[i] ? kept : dropped).push(i);
    const keptRuns: [number, number][] = [];
    let prev = -2;
    let keptBytes = 0;
    for (const i of kept) {
        keptBytes += ctx.costOf(all[i]!, clips[i] ?? null, rclips[i] ?? null);
        if (i === prev + 1) keptRuns[keptRuns.length - 1]![1] = i + 1;
        else keptRuns.push([i + 1, i + 1]);
        prev = i;
    }
    const out: BudgetSelection = { kept, dropped, keptRuns, keptBytes };
    if (declared) out.clips = clips; // 无人声明 clip ⇒ 字段不出现（读侧兼容）
    if (rDeclared) out.reasoningClips = rclips; // 同上（推理轴；两轴各报各的）
    return out;
}
