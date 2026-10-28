// tests/core/compact-example.test.ts
// 范例预览只做展示；留谁丢谁走 `selectKeptBoundary`（唯一判据）。
import { describe, expect, it } from "vitest";
import {
    EXAMPLE_MESSAGES,
    buildCompactExample,
    bytesToTokens,
    type ExampleMessage,
} from "../../src/shared/context/compact-example";
import { estimateTokensOf } from "../../src/shared/context/history-limit";
import { RETAIN_RATIO, selectKeptBoundary, triggerTokensOf } from "../../src/shared/context/select-kept-boundary";

function m(id: string, bytes: number, kind: ExampleMessage["kind"] = "text"): ExampleMessage {
    return {
        id,
        turn: "t1",
        role: kind === "user" ? "user" : kind === "result" ? "tool" : "assistant",
        kind,
        label: id,
        bytes,
    };
}

function keptIdsByBoundary(messages: readonly ExampleMessage[], retainTokens: number): string[] {
    const window = Math.max(1, Math.round(retainTokens / RETAIN_RATIO));
    const { cut } = selectKeptBoundary(
        messages.map((x) => ({ tokens: bytesToTokens(x.bytes), user: x.role === "user" })),
        retainTokens,
        triggerTokensOf(window),
    );
    return messages.filter((_, i) => i >= cut).map((x) => x.id);
}

describe("compact-example · 展示层", () => {
    it("合成样例：6 轮 / 20 条，工具结果远大于正文", () => {
        expect(EXAMPLE_MESSAGES).toHaveLength(20);
        expect(new Set(EXAMPLE_MESSAGES.map((x) => x.turn)).size).toBe(6);
        const maxResult = Math.max(...EXAMPLE_MESSAGES.filter((x) => x.kind === "result").map((x) => x.bytes));
        const maxText = Math.max(...EXAMPLE_MESSAGES.filter((x) => x.kind === "text").map((x) => x.bytes));
        expect(maxResult).toBeGreaterThan(maxText);
    });

    it("tokens 口径 = bytesToTokens（3 字节 ≈ 1 token，样例正文是中文）", () => {
        const r = buildCompactExample(3 * 1024);
        for (const row of r.rows) expect(row.tokens).toBe(bytesToTokens(row.bytes));
    });

    it("样例口径与真压同源：中文文本上 bytesToTokens ≈ estimateTokensOf", () => {
        for (const t of [
            "先定位：四百零一来自过期判断，时钟漂移会导致误判。",
            "测试要覆盖两侧，否则漂移方向的问题测不出来。",
            "已开请求已签未合并，检查通过零错误。",
        ]) {
            const byBytes = bytesToTokens(Buffer.byteLength(t, "utf-8"));
            const real = estimateTokensOf(t);
            expect(Math.abs(byBytes - real) / real).toBeLessThan(0.1);
        }
    });

    it.each([3 * 1024, 12 * 1024, 1_000_000])("保留集合与判据一致（retain %i token）", (budget) => {
        const r = buildCompactExample(budget);
        expect(r.rows.filter((x) => x.kept).map((x) => x.id)).toEqual(keptIdsByBoundary(r.rows, budget));
    });

    it("展示字段自洽", () => {
        const r = buildCompactExample(3 * 1024);
        const keptRows = r.rows.filter((x) => x.kept);
        expect(r.dropped).toBe(r.rows.length - keptRows.length);
        expect(r.keptBytes).toBe(keptRows.reduce((a, x) => a + x.bytes, 0));
        expect(r.beforeBytes).toBe(r.rows.reduce((a, x) => a + x.bytes, 0));
    });

    it("why 两档：本次请求里 / 超出保留量", () => {
        const r = buildCompactExample(12 * 1024);
        const whys = new Set(r.rows.map((x) => x.why));
        expect([...whys].some((w) => w.includes("本次请求"))).toBe(true);
        expect([...whys].some((w) => w.includes("超出保留量"))).toBe(true);
    });

    it("biggestDrop = 被丢掉的最大一块", () => {
        const r = buildCompactExample(12 * 1024);
        const dropped = r.rows.filter((x) => !x.kept);
        expect(dropped.length).toBeGreaterThan(0);
        const maxDropped = Math.max(...dropped.map((x) => x.bytes));
        expect(r.biggestDrop?.bytes).toBe(maxDropped);
    });

    it("retain=0（窗口未知）⇒ 全部进不去本次请求", () => {
        const r = buildCompactExample(0);
        expect(r.rows.every((x) => !x.kept)).toBe(true);
        expect(r.keptBytes).toBe(0);
    });

    it("保留量足够大 ⇒ 一条不丢", () => {
        const r = buildCompactExample(200_000);
        expect(r.dropped).toBe(0);
        expect(r.keptBytes).toBe(r.beforeBytes);
    });

    it("小样例：user 切点", () => {
        const msgs = [m("u", 1000, "user"), m("a", 1000), m("b", 1000), m("c", 1000), m("d", 1000)];
        const r = buildCompactExample(3_000, msgs);
        expect(r.rows.filter((x) => x.kept).map((x) => x.id)).toEqual(keptIdsByBoundary(msgs, 3_000));
    });
});
