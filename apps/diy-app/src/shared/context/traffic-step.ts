// src/shared/context/traffic-step.ts
// 🎯 变更历史（changelog）的一步 → 它在**流量日志**里的那条真实 HTTP 请求。
//
// 为什么需要它：changelog 记的是"上下文在这一步变了什么"，而"这一步实际发出去的是什么"
// 只有流量日志（`log/network/<date>.jsonl`）是**地面真相**。两者靠 `turnId` 关联
// （真发时 `noteRun` 登记，流量日志每条都带 turnId / taskUri）。
//
// 为什么不能按"第几条"取：一个 turn 会发**多次**请求（`streamText` 每步一次真发），
// 而老字段 `attempt` 是**本次运行内的请求序号**（每次请求 +1，重试也 +1）—— 它并不等于"第几步"
// （一次重试就会把后面的序号整体顶歪）。所以判据用**时刻**：
// changelog 那条是在 `prepareStep`（该步请求**之前**）写的，于是"该步的请求"= 该 turn 里
// ts ≥ 记录 ts 的**第一条**。重试天然被吸收（重试在记录之后，取到的仍是这一步那条）。
//
// ##409 起记录自带步号（`stepSeq` + `attemptInStep`，由 `traffic.noteStep` 在那一步的请求
// 之前登记）：有步号时**优先按步号**取（老记录没有这两个字段 → 自动退回时刻判据）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

/** 流量日志一条里我们关心的字段（traffic.query 的 records 是其超集） */
export interface TrafficStepRecord {
    ts: number;
    turnId: string | null;
    taskUri: string | null;
    /** 【老字段】本次运行内的请求序号（每次请求 +1，含重试）—— 只用于展示，不当步序用 */
    attempt: number;
    /** 逻辑步序号（1 起；与变更历史的 stepNo 同号）。老记录没有 → 省略 */
    stepSeq?: number | null;
    /** 该步内第几次 HTTP 往返（1 = 首试，>1 = 重试）。老记录没有 → 省略 */
    attemptInStep?: number | null;
    status: number | null;
    model: string;
    /** 落盘位置（有它才能跳回流量页定位） */
    log: { file: string; line: number; abs: string } | null;
}

export interface StepTrafficPick<T> {
    /** 该步对应的那条请求 */
    record: T;
    /** 该 turn 在流量日志里的**全部**请求条数（含重试）—— 徽章用，让人知道这里挑过 */
    turnRecords: number;
}

/**
 * 从流量记录里挑出「某一步」的那条请求。
 *
 * 规则（刻意保守，宁可给不出也不给错的）：
 *   · 只认 `turnId` 完全相等（`taskUri` 也相等）；
 *   · 记录带步号（`stepSeq`，##409 之后）→ 取该步**首试**那条（`attemptInStep` 最小者）；
 *   · 老记录没有步号，有 `entryTs`（changelog 那条的时刻）时：取该 turn 里 **ts ≥ entryTs 的第一条**
 *     —— 记录写在该步请求之前，故第一条之后的请求就是这一步的；重试自动吸收；
 *     若 entryTs 晚于该 turn 全部记录（不该发生）→ 退化为最后一条；
 *   · 没给 `entryTs` 时退化为按 ts 升序取第 `step` 条（调用方给不出时刻的老用法）；
 *   · 条数不够 / 找不到 → `null`（UI 出声，不编）。
 */
export function pickStepTraffic<T extends TrafficStepRecord>(
    records: readonly T[],
    ref: { turnId: string; step: number },
    taskUri: string | null,
    entryTs?: string | null,
): StepTrafficPick<T> | null {
    const turnAll = records
        .filter((r) => r.turnId === ref.turnId && (!taskUri || r.taskUri === taskUri))
        .sort((a, b) => a.ts - b.ts);
    if (turnAll.length === 0) return null;
    // 有步号（##409 之后的记录）就按步号取**首试**那条 —— 比时刻判据更硬：不依赖时钟先后，
    // 也不怕记录写入晚于请求。老记录没有步号 → 落到下面的时刻判据。
    const byStep = turnAll.filter((r) => r.stepSeq === ref.step);
    if (byStep.length > 0) {
        const first = byStep.find((r) => (r.attemptInStep ?? 1) === 1) ?? byStep[0]!;
        return { record: first, turnRecords: turnAll.length };
    }
    const t = entryTs ? Date.parse(entryTs) : NaN;
    if (Number.isFinite(t)) {
        const after = turnAll.find((r) => r.ts >= t);
        const rec = after ?? turnAll[turnAll.length - 1]!;
        return { record: rec, turnRecords: turnAll.length };
    }
    const idx = ref.step - 1;
    if (idx < 0 || idx >= turnAll.length) return null;
    return { record: turnAll[idx]!, turnRecords: turnAll.length };
}

/**
 * 一步的**重试链**：该步的 HTTP 往返按 ts 升序（[0] = 首试），回答
 * 「这一步试了几次 / 每次各自 status·ms·err / 最后一次成没成」。
 */
export interface StepChain<T> {
    /** 逻辑步序号（1 起，同记录里的 stepSeq） */
    stepSeq: number;
    /** 该步的往返记录，按 ts 升序（[0] = 首试，其后依次是重试） */
    attempts: T[];
    /** 重试次数 = attempts.length - 1（0 = 一次过） */
    retries: number;
    /** 最后一次是否成功（2xx/3xx；null 状态 / 4xx / 5xx 都算不成） */
    lastOk: boolean;
}

/**
 * 按 `stepSeq` 把记录分组 → 每一步一条重试链（按步号升序）。
 *
 * 只用**带步号**的记录：`stepSeq` 为 null / 缺失的（探测、摘要、老记录）不成步，直接跳过 ——
 * 它们本来就没有"第几步"这回事，硬塞进链里会撒谎。
 */
export function groupByStep<T extends TrafficStepRecord>(records: readonly T[]): StepChain<T>[] {
    const byStep = new Map<number, T[]>();
    for (const r of records) {
        if (typeof r.stepSeq !== "number") continue;
        const list = byStep.get(r.stepSeq);
        if (list) list.push(r);
        else byStep.set(r.stepSeq, [r]);
    }
    return [...byStep.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([stepSeq, list]) => {
            const attempts = [...list].sort((a, b) => a.ts - b.ts);
            const last = attempts[attempts.length - 1]!;
            return {
                stepSeq,
                attempts,
                retries: attempts.length - 1,
                lastOk: last.status !== null && last.status >= 200 && last.status < 400,
            };
        });
}

/** 流量日志文件 → 日期（`log/network/2026-10-15.jsonl` → `2026-10-15`；认不出给 null） */
export function dateOfLogFile(file: string | null): string | null {
    if (!file) return null;
    const m = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
    return m ? m[1]! : null;
}
