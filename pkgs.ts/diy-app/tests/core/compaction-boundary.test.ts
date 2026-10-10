// tests/core/compaction-boundary.test.ts
// 🎯 压缩边界锚点：**全清后新产生的轮必须保留**（回归「压缩后发的消息全消失」）
import { describe, it, expect } from "vitest";
import {
    resolveBoundary,
    turnIdAtOrAfterOp,
    listTurnIds,
    parseCompactLog,
    type CompactEventRecord,
    normalizePolicy,
    type OpLike,
} from "../../src/shared/context/compaction";

/** 一条 compact 账（全清：keptFromTurnId=null，锚点 = 压缩时刻已有 op 数） */
function clearAllLedger(keepFromOpIndex: number): CompactEventRecord {
    return {
        kind: "compact",
        v: 2,
        id: "c1",
        ts: "c1",
        by: "ui",
        trigger: "manual",
        policy: normalizePolicy({ budgetBytes: 0, toolResult: { render: "asis" } }),
        boundary: { keptFromTurnId: null, keepFromOpIndex },
        size: {
            before: { turns: 3, messages: 6, bytes: 300, estTokens: 75 },
            after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 },
            keptTurns: 0,
            droppedTurns: 3,
        },
    };
}

describe("边界锚点 keepFromOpIndex（回归：压缩后发的消息消失）", () => {
    const t1: OpLike[] = [
        { op: "start", id: "a1", kind: "turn" },
        { op: "stop", id: "a1" },
        { op: "start", id: "a2", kind: "turn" },
        { op: "stop", id: "a2" },
    ];

    it("全清瞬间：锚点 = 已有 op 数 → turnIdAtOrAfterOp 返回 null（真发空，符合压缩那一刻）", () => {
        const b = resolveBoundary([clearAllLedger(t1.length)])!;
        expect(b.keepFromOpIndex).toBe(4);
        expect(turnIdAtOrAfterOp(t1, b.keepFromOpIndex)).toBeNull();
    });

    it("全清后**追加新轮**：锚点不变，新轮被保留（不再被吞）", () => {
        const withNew: OpLike[] = [
            ...t1,
            { op: "start", id: "a3", kind: "turn" },
            { op: "stop", id: "a3" },
        ];
        const b = resolveBoundary([clearAllLedger(t1.length)])!;
        // 新轮 a3 从下标 4 起 —— 正是锚点位置 → 命中
        expect(turnIdAtOrAfterOp(withNew, b.keepFromOpIndex)).toBe("a3");
    });

    it("history 的切片语义：ops.slice(keepFromOpIndex) 保留新轮、丢弃压缩前的轮", () => {
        const withNew: OpLike[] = [
            ...t1,
            { op: "start", id: "a3", kind: "turn" },
            { op: "stop", id: "a3" },
        ];
        const b = resolveBoundary([clearAllLedger(t1.length)])!;
        const sliced = withNew.slice(b.keepFromOpIndex);
        expect(listTurnIds(sliced)).toEqual(["a3"]);
    });

    it("老账本缺 keepFromOpIndex → 回退 -1（下游按 keptFromTurnId 推导，不崩）", () => {
        const legacy = JSON.stringify({
            kind: "compact", v: 1, id: "L", ts: "L", by: "cli",
            policy: normalizePolicy({ budgetBytes: 0, toolResult: { render: "asis" } }),
            boundary: { keptFromTurnId: null, keptTurns: 0, droppedTurns: 1 },
            before: { turns: 1, messages: 2, bytes: 10, estTokens: 3 },
            after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 },
        });
        const b = resolveBoundary(parseCompactLog(legacy))!;
        expect(b.keepFromOpIndex).toBe(-1);
    });

    it("非空保留起点：锚点在保留首轮的 op 下标（非 null 路径不变）", () => {
        const ev = clearAllLedger(2);
        ev.boundary.keptFromTurnId = "a2";
        ev.boundary.keepFromOpIndex = 2;
        const b = resolveBoundary([ev])!;
        expect(b.keptFromTurnId).toBe("a2");
        expect(turnIdAtOrAfterOp(t1, b.keepFromOpIndex)).toBe("a2");
    });
});
