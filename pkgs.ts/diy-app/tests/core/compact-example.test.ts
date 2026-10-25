import { describe, expect, it } from "vitest";
import {
    EXAMPLE_MESSAGES,
    buildCompactExample,
    bytesToTokens,
    type ExampleMessage,
} from "../../src/shared/context/compact-example";
import { selectKeptBoundary } from "../../src/shared/context/select-kept-boundary";

// ⚠️ 本文件**不复制算法**：留谁丢谁的唯一判据在 `select-kept-boundary.test.ts`。
// 这里只钉两件事：① 预览确实走的是同一个 `selectKeptBoundary`（示例与真实行为同源）；
// ② 翻译出来的展示字段（dropped / keptBytes / why / biggestDrop）对得上。

function m(
    id: string,
    bytes: number,
    kind: ExampleMessage["kind"] = "text",
    callId?: string,
): ExampleMessage {
    return {
        id,
        turn: "t1",
        role: kind === "user" ? "user" : kind === "result" ? "tool" : "assistant",
        kind,
        label: id,
        bytes,
        ...(callId ? { callId } : {}),
    };
}

/** 用同一个边界函数算「期望保留的 id」—— 期望值来自唯一实现点，不是另写一套 */
/** 参照实现：**直接**调判据（`buildCompactExample` 现在收 token，不再是字节） */
function keptIdsByBoundary(messages: readonly ExampleMessage[], budgetTokens: number): string[] {
    const { headEnd, cut } = selectKeptBoundary(
        messages.map((x) => ({ tokens: bytesToTokens(x.bytes), kind: x.kind, callId: x.callId })),
        budgetTokens,
    );
    return messages.filter((_, i) => i <= headEnd || i >= cut).map((x) => x.id);
}

describe("compact-example · 范例预览（展示层，判据走 selectKeptBoundary）", () => {
    it("合成样例：6 轮 / 20 条，尺寸不均匀（工具结果远大于正文）", () => {
        expect(EXAMPLE_MESSAGES).toHaveLength(20);
        expect(new Set(EXAMPLE_MESSAGES.map((x) => x.turn)).size).toBe(6);
        const maxResult = Math.max(...EXAMPLE_MESSAGES.filter((x) => x.kind === "result").map((x) => x.bytes));
        const maxText = Math.max(...EXAMPLE_MESSAGES.filter((x) => x.kind === "text").map((x) => x.bytes));
        expect(maxResult).toBeGreaterThan(maxText);
    });

    it("tokens 口径 = 字节 ÷ 4", () => {
        const r = buildCompactExample(3 * 1024);
        for (const row of r.rows) expect(row.tokens).toBe(bytesToTokens(row.bytes));
    });

    it.each([0, 3 * 1024, 12 * 1024, 1_000_000])("保留集合与 selectKeptBoundary 完全一致（上限 %i token）", (budget) => {
        const r = buildCompactExample(budget);
        expect(r.rows.filter((x) => x.kept).map((x) => x.id)).toEqual(keptIdsByBoundary(r.rows, budget));
    });

    it("保留集合同理（传小样例）", () => {
        const msgs = [m("u", 1000, "user"), m("a", 1000), m("b", 1000), m("c", 1000), m("d", 1000)];
        for (const budget of [0, 500, 3000, 100_000]) {
            const r = buildCompactExample(budget, msgs);
            expect(r.rows.filter((x) => x.kept).map((x) => x.id)).toEqual(keptIdsByBoundary(msgs, budget));
        }
    });

    it("展示字段：dropped / keptBytes / beforeBytes 与 rows 自洽", () => {
        const r = buildCompactExample(3 * 1024);
        const keptRows = r.rows.filter((x) => x.kept);
        expect(r.dropped).toBe(r.rows.length - keptRows.length);
        expect(r.keptBytes).toBe(keptRows.reduce((a, x) => a + x.bytes, 0));
        expect(r.beforeBytes).toBe(r.rows.reduce((a, x) => a + x.bytes, 0));
    });

    it("why 三档文案：保头 / 装进上限 / 超出上限", () => {
        const r = buildCompactExample(3 * 1024);
        const whys = new Set(r.rows.map((x) => x.why));
        expect([...whys].some((w) => w.includes("保头"))).toBe(true);
        expect([...whys].some((w) => w.includes("从最后往前数"))).toBe(true);
        expect([...whys].some((w) => w.includes("超出上限"))).toBe(true);
    });

    it("biggestDrop = 被丢掉的那块里最大的一个（样例里是工具结果）", () => {
        const r = buildCompactExample(3 * 1024);
        const dropped = r.rows.filter((x) => !x.kept);
        const maxDropped = Math.max(...dropped.map((x) => x.bytes));
        expect(r.biggestDrop?.bytes).toBe(maxDropped);
        expect(r.biggestDrop?.kind).toBe("result");
    });

    it("上限 0 ⇒ 只剩保头，其余全丢", () => {
        const r = buildCompactExample(0);
        const headRows = r.rows.slice(0, r.headEnd + 1);
        expect(headRows.every((x) => x.kept)).toBe(true);
        expect(r.rows.slice(r.headEnd + 1).every((x) => !x.kept)).toBe(true);
        expect(r.keptBytes).toBe(headRows.reduce((a, x) => a + x.bytes, 0));
    });

    it("上限足够大（≥ 总量 ÷ 保留比例）⇒ 一条不丢", () => {
        // ##432 刀 2：一次压缩只保留到**上限的一半**（RETAIN_RATIO），所以「不丢」要上限 ≥ 总量 × 2
        const r = buildCompactExample(200_000);
        expect(r.dropped).toBe(0);
        expect(r.keptBytes).toBe(r.beforeBytes);
    });
});
