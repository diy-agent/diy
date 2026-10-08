// src/shared/context/compact-points.ts
// 🎯 压缩点位 → 请求（步）的映射（纯函数，禁止 import node:*）
//
// 【用户 2026-10-08】压缩可能发生在**一轮中间** ⇒ 用「轮次总表」表达不了「哪个请求被压过」，
// 必须落到**分表（按步）**：一步 = 一次请求。
//
// ── 判据（与 M2 的「在途轮次用轮首快照」一致，review 2026-10-08 修正）──
// 点位 = 该压缩事件之后的**第一条「轮首请求」**（step===1）—— 即**下一个真正用到新配置**的请求。
// 为什么不取「ts 之后的第一条请求」：`runTurn` 在**轮首**构建一次历史快照（`sent`），`prepareStep`
// 只注入插话、**不重建历史** ⇒ **轮次中改配置不影响在途轮次**，要到**下一轮轮首**才生效
// （core 单测 `local-agent-midturn-config` 钉住）。故轮中压缩时，该轮后续步**不算**被压过。
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
 * 把每个压缩事件映射到它之后的**第一条「轮首请求」**（step===1）= 下一个用到新配置的请求。
 * 多个事件先后落在同一请求上时，该键对应一个**升序数组**（如实列全部）。
 * 事件之后没有**轮首请求**（轮中压完没开新轮）→ 该事件不映射（尚无请求受其影响）。
 *
 * ⚠️ 同刻（`s.ts === ev.ts`）按「之后的请求」处理（`>=`）——压缩那一刻尚未发出的请求算受其影响。
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
        // 轮首请求（step===1）且在其后 —— 见文件头注（在途轮次不换历史）
        const hit = ss.find((s) => s.step === 1 && s.ts >= ev.ts);
        if (!hit) continue;
        const k = stepKey(hit);
        const arr = map.get(k);
        if (arr) arr.push(ev);
        else map.set(k, [ev]);
    }
    return map;
}
