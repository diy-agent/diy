// tests/core/compact-points.test.ts
// 🎯 压缩点位 → 请求（步）的映射：压缩事件之后的**第一条请求**被标记（##272 M4）
import { describe, it, expect } from "vitest";
import { mapCompactPointsToSteps, stepKey } from "../../src/shared/context/compact-points";
import type { CompactEventRecord } from "../../src/shared/context/compaction";

const step = (turnId: string, s: number, ts: string) => ({ turnId, step: s, ts });

/** 最小可用的 compact 事件（只用 map 关心的字段） */
function ev(ts: string, id = ts): CompactEventRecord {
    return {
        kind: "compact",
        v: 2,
        id,
        ts,
        by: "ui",
        trigger: "manual",
        policy: { mode: "budget", modeData: { budgetBytes: 3072, toolResult: { render: "asis" } }, summary: false },
        boundary: { keptFromTurnId: null, keepFromOpIndex: 0 },
        size: {
            before: { turns: 3, messages: 6, bytes: 300, estTokens: 75 },
            after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 },
            keptTurns: 0,
            droppedTurns: 3,
        },
    };
}

describe("mapCompactPointsToSteps（压缩点位按步标注）", () => {
    it("事件落在两步之间 → 标记其后第一步（跨轮）", () => {
        const steps = [step("t1", 1, "2026-01-01T00:00:00Z"), step("t2", 1, "2026-01-01T00:10:00Z")];
        const m = mapCompactPointsToSteps(steps, [ev("2026-01-01T00:05:00Z")]);
        expect([...m.keys()]).toEqual([stepKey({ turnId: "t2", step: 1 })]);
    });

    it("压缩发生在一轮中间 → 标记该轮的后一步（分表才体现得出）", () => {
        const steps = [
            step("t1", 1, "2026-01-01T00:00:00Z"),
            step("t1", 2, "2026-01-01T00:05:00Z"),
            step("t1", 3, "2026-01-01T00:10:00Z"),
        ];
        // 事件在 s1 与 s2 之间 → 标记 s2（不是整轮）
        const m = mapCompactPointsToSteps(steps, [ev("2026-01-01T00:03:00Z")]);
        expect([...m.keys()]).toEqual([stepKey({ turnId: "t1", step: 2 })]);
    });

    it("事件恰在请求 ts 上（同刻）→ 归该请求（>= 判据）", () => {
        const steps = [step("t1", 1, "2026-01-01T00:00:00Z"), step("t1", 2, "2026-01-01T00:05:00Z")];
        const m = mapCompactPointsToSteps(steps, [ev("2026-01-01T00:05:00Z")]);
        expect([...m.keys()]).toEqual([stepKey({ turnId: "t1", step: 2 })]);
    });

    it("多次压缩先后落在同一请求 → 该键对应升序数组", () => {
        const steps = [step("t1", 1, "2026-01-01T00:00:00Z"), step("t1", 2, "2026-01-01T00:20:00Z")];
        const m = mapCompactPointsToSteps(steps, [
            ev("2026-01-01T00:05:00Z", "a"),
            ev("2026-01-01T00:10:00Z", "b"),
        ]);
        expect(m.get(stepKey({ turnId: "t1", step: 2 }))?.map((e) => e.id)).toEqual(["a", "b"]);
    });

    it("事件之后没有请求（压完没再发）→ 不映射", () => {
        const steps = [step("t1", 1, "2026-01-01T00:00:00Z")];
        const m = mapCompactPointsToSteps(steps, [ev("2026-01-01T00:30:00Z")]);
        expect(m.size).toBe(0);
    });

    it("非 compact 事件（undo/measure）不参与点位", () => {
        const steps = [step("t1", 1, "2026-01-01T00:00:00Z"), step("t1", 2, "2026-01-01T00:10:00Z")];
        const undo = { kind: "undo", v: 2, id: "u", ts: "2026-01-01T00:05:00Z", ref: "x" } as unknown as CompactEventRecord;
        const m = mapCompactPointsToSteps(steps, [undo]);
        expect(m.size).toBe(0);
    });
});
