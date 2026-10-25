// src/main/services/self-usage.ts
// 🎯 `runtime.self` 的**取数**（memory 账：本进程里最近一步的桶 + 本轮累计）。
//
// 为什么取「内存里的最近一步」而不是读 `usage.jsonl`：
//   ① 每步重建上下文（prepareStep）是**热路径**，一次同步文件读就把渲染/RPC 一起按停
//      （`rule.async-io` 的判据不是"会不会卡"，是"主进程是单线程事件循环"）；
//   ② `usage` 属会话数据而非领域真源（`data.log` 那节的分档）—— 让上下文构造依赖日志
//      正是 `rule.core-log` 要禁止的形态。这里记账只在**写使用点**顺手发生（appendUsage 同一处），
//      读时零 IO。
//
// 代价（必须明说，别让读的人以为数是全量的）：
//   · **进程重启后清空** ⇒ 重启后的第一轮没有 `window` / `last`（给不出就不给，不编）。
//     `turn.*` 不受影响：它来自本轮现场（`stepN` / `turnCost`）。
//   · 只保留**最近一步**（用于窗口占用与缓存命中），不累积历史 —— 累积归账本（`usage.jsonl`），
//     agent 要看全量请跑 `diy agent local usage`。
//
// 为什么不在这里做任务级累计（##9 提案里的 `task.cost`）：
//   那需要跨启动的历史（读账本 = 热路径上的 IO，见上），而"本轮花了多少"已足够回答
//   "这轮值不值"。任务累计的正确出口是 CLI（`diy agent local usage-total` 一族），
//   不是每轮投给模型的常量。

import type { CostBreakdown } from "../../shared/usage";
import { buildSelfValue, type SelfBuckets, type SelfValue } from "../../shared/context/self";

interface LastStep {
    buckets: SelfBuckets;
    cost: CostBreakdown | null;
}

/**
 * 每个任务「最近一步」的快照。
 * 上限只是防内存无界（任务数 × 一个对象很小）；超了按插入顺序丢最旧（Map 保持插入序）。
 */
const lastOf = new Map<string, LastStep>();
const MAX_TASKS = 512;

/** 记一步（在每步 finish-step 落账处调；**只给 runTurn 用**，不要在别处补） */
export function noteSelfStep(taskUri: string, buckets: SelfBuckets, cost: CostBreakdown | null): void {
    if (lastOf.has(taskUri)) lastOf.delete(taskUri);
    lastOf.set(taskUri, {
        buckets: { total: buckets.total, outputTotal: buckets.outputTotal, cacheRead: buckets.cacheRead, inputTotal: buckets.inputTotal },
        cost,
    });
    if (lastOf.size > MAX_TASKS) {
        const oldest = lastOf.keys().next();
        if (!oldest.done) lastOf.delete(oldest.value);
    }
}

/**
 * 组出该任务的 `runtime.self`（给 `assembleGlobals` 的 `self` 入参）。
 * 返回 null = 无可报（新进程首轮首步）⇒ 整节缺席。
 */
export function selfOf(
    taskUri: string,
    turn: { contextLimit?: number | null; steps: number; cost: CostBreakdown | null; unpriced?: number },
): SelfValue | null {
    const last = lastOf.get(taskUri) ?? null;
    return buildSelfValue({
        lastBuckets: last?.buckets ?? null,
        lastCost: last?.cost ?? null,
        contextLimit: turn.contextLimit ?? null,
        turnSteps: turn.steps,
        turnCost: turn.cost,
        turnUnpriced: turn.unpriced,
    });
}

/** 测试钩子：清空内存账（生产代码不调） */
export function resetSelfUsage(): void {
    lastOf.clear();
}
