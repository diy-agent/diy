// src/shared/context/compact-points.ts
// 🎯 压缩点位 → 请求（步）的映射（纯函数，禁止 import node:*）
//
// 【用户 2026-10-08】压缩可能发生在**一轮中间** ⇒ 用「轮次总表」表达不了「哪个请求被压过」，
// 必须落到**分表（按步）**：一步 = 一次请求。判据 = 该压缩事件 ts 之后的**第一条请求**即被压过。
//
// 为什么按 ts 对时而不用边界：配置/历史分离后，投递按**当前配置**实时算（`pit.config-vs-history`），
// 压缩事件只写一条快照；「哪次请求被这次配置改动影响」只能由**时间先后**判定（事件 ts ≤ 请求 ts）。

import type { CompactEventRecord } from "./compaction";

/** 定时所需的最小步信息（真身是 shared/usage 的 StepUsageRecord） */
export interface StepRef {
    ts: string;
    turnId: string;
    step: number;
}

/** 步的键（turnId + 步号，唯一标识一次请求） */
export function stepKey(r: { turnId: string; step: number }): string {
    return `${r.turnId}#${r.step}`;
}

/**
 * 把每个压缩事件映射到它之后的**第一条请求**（= 被这次压缩影响的请求）。
 * 多个事件先后落在同一请求上时，该键对应一个**升序数组**（如实列全部）。
 * 事件之后没有请求（压缩完没再发）→ 该事件不映射（点位无请求可标）。
 */
export function mapCompactPointsToSteps(
    steps: readonly StepRef[],
    events: readonly CompactEventRecord[],
): Map<string, CompactEventRecord[]> {
    const ss = steps.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const evs = events
        .filter((e) => e.kind === "compact")
        .slice()
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const map = new Map<string, CompactEventRecord[]>();
    for (const ev of evs) {
        const hit = ss.find((s) => s.ts >= ev.ts);
        if (!hit) continue;
        const k = stepKey(hit);
        const arr = map.get(k);
        if (arr) arr.push(ev);
        else map.set(k, [ev]);
    }
    return map;
}
