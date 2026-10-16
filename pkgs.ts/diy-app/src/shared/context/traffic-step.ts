// src/shared/context/traffic-step.ts
// 🎯 变更历史（changelog）的一步 → 它在**流量日志**里的那条真实 HTTP 请求。
//
// 为什么需要它：changelog 记的是"上下文在这一步变了什么"，而"这一步实际发出去的是什么"
// 只有流量日志（`log/network/<date>.jsonl`）是**地面真相**。两者靠 `turnId` 关联
// （真发时 `noteRun` 登记，流量日志每条都带 turnId / taskUri）。
//
// 为什么不能按"第几条"取：一个 turn 会发**多次**请求（`streamText` 每步一次真发），
// 而 `attempt` 是**本次运行内的请求序号**（每次请求 +1，重试也 +1）—— 它并不等于"第几步"
// （一次重试就会把后面的序号整体顶歪）。所以判据用**时刻**：
// changelog 那条是在 `prepareStep`（该步请求**之前**）写的，于是"该步的请求"= 该 turn 里
// ts ≥ 记录 ts 的**第一条**。重试天然被吸收（重试在记录之后，取到的仍是这一步那条）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

/** 流量日志一条里我们关心的字段（traffic.query 的 records 是其超集） */
export interface TrafficStepRecord {
    ts: number;
    turnId: string | null;
    taskUri: string | null;
    /** 本次运行内的请求序号（每次请求 +1，含重试）—— 只用于展示，不当步序用 */
    attempt: number;
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
 *   · 有 `entryTs`（changelog 那条的时刻）时：取该 turn 里 **ts ≥ entryTs 的第一条**
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

/** 流量日志文件 → 日期（`log/network/2026-10-15.jsonl` → `2026-10-15`；认不出给 null） */
export function dateOfLogFile(file: string | null): string | null {
    if (!file) return null;
    const m = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
    return m ? m[1]! : null;
}
