// src/shared/context/self.ts
// 🎯 `runtime.self` 的值：**agent 自己这一步花了多少、窗口还剩多少**。
//
// 为什么要有（##404 / ##9 提案）：模型被告知"上下文快满了""前缀缓存掉了"之前，
// 只能靠猜 —— 于是"该收尾了"永远靠人喊。这里只放**能改变行为**的三个数（判据见下），
// 别的（tok/s、per-tool 耗时、chunk 间隔）看得到但无法据此改决定，一律不放（纯占字节）。
//
//   ① `window.ratio` —— 本步请求的 token 占窗口的百分比。>60% 就该收尾 / 少堆长输出。
//   ② `last.cacheHit` —— 上一步的缓存命中率。从 90%+ 掉到 <50% ⇒ **前缀缓存被打断**
//      （输入成本 ×N），最直接的自证就是"刚才不该动 system 段"。
//   ③ `turn.cost` —— 本轮的累计花费（汇报时给数，替代"感觉不便宜"）。
//
// 硬约束（##9 提、我采纳）：
//   · **绝不能进 system 段**：每步都变 ⇒ 前缀缓存全废。故 `PLACE_CANDIDATES` 里 `system: false`。
//   · **给不出的数就不给**（缺席而不是 0 / "—"）：`0%` 与"没量到"是两件事，
//     编一个数会被当成事实（这正是 facts `/ 预算` 那一族的老病）。
//
// 为什么是**纯函数**：口径必须可单测、可预览；取数（内存里的上一步账）归 main 的
// `services/self-usage.ts`，本文件零 IO、零 node 依赖。

import { cacheHitRate, windowRate, type CostBreakdown, type UsageBuckets } from "../usage";

/** 一步的四个桶（够算窗口与命中率的最小集合） */
export type SelfBuckets = Pick<UsageBuckets, "total" | "outputTotal" | "cacheRead" | "inputTotal">;

export interface SelfValue {
    window?: {
        /** 本步请求的总 token（输入 + 输出） */
        used: number;
        /** 模型窗口上限（tokens） */
        limit: number;
        /** `used / limit`，**百分数**（0~100，保留 1 位）—— 便于直接比大小，不用自己乘 100 */
        ratio: number;
    };
    last?: {
        /** 上一步的缓存命中率，**百分数**（0~100，保留 1 位）；量不到则缺席 */
        cacheHit?: number;
        /** 上一步的输出 token（文本 + 思考） */
        output: number;
        /** 上一步的金额（USD，数字）；无价目则缺席（**不写 0**） */
        cost?: number;
    };
    turn?: {
        /** 本轮已走的步数 */
        steps: number;
        /** 本轮累计金额（USD）；一步都没价目则缺席 */
        cost?: number;
        /** 本轮**无价目**的步数（>0 ⇒ `cost` 是部分和，不能当成完整花费） */
        unpriced?: number;
    };
}

export interface SelfInput {
    /** 上一步（本进程内**最近一次**真发的步）的桶；没有（新进程第一步 / 首轮首步）则 null */
    lastBuckets: SelfBuckets | null;
    /** 上一步的金额；无价目则 null */
    lastCost: CostBreakdown | null;
    /** 模型窗口上限；未知则 undefined / null */
    contextLimit?: number | null;
    /** 本轮已走步数 */
    turnSteps: number;
    /** 本轮累计金额；一步都没价目则 null */
    turnCost: CostBreakdown | null;
    /** 本轮无价目的步数 */
    turnUnpriced?: number;
}

const pct = (r: number): number => Math.round(r * 1000) / 10;
/** 金额保留到 6 位小数（小额四舍五入成 0 就白给了，与 `fmtCost` 同口径） */
const money = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * 组装 `runtime.self` 的值。
 *
 * 返回 `null` = **一条数都给不出**（两者皆无）⇒ 整节缺席，与未接入前逐字不变。
 * 只要有一项可算就返回对象（缺的子项缺席，绝不补 0）。
 */
export function buildSelfValue(i: SelfInput): SelfValue | null {
    const out: SelfValue = {};
    const b = i.lastBuckets;
    if (b) {
        const rate = windowRate(b, i.contextLimit ?? undefined);
        if (rate != null && i.contextLimit) out.window = { used: b.total, limit: i.contextLimit, ratio: pct(rate) };
        const hit = cacheHitRate(b);
        const last: NonNullable<SelfValue["last"]> = { output: b.outputTotal };
        if (hit != null) last.cacheHit = pct(hit);
        if (i.lastCost) last.cost = money(i.lastCost.total);
        out.last = last;
    }
    if (i.turnSteps > 0) {
        const turn: NonNullable<SelfValue["turn"]> = { steps: i.turnSteps };
        if (i.turnCost) turn.cost = money(i.turnCost.total);
        if (i.turnUnpriced && i.turnUnpriced > 0) turn.unpriced = i.turnUnpriced;
        out.turn = turn;
    }
    return Object.keys(out).length > 0 ? out : null;
}
