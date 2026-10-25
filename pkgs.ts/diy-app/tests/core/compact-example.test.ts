import { describe, expect, it } from "vitest";
import {
    EXAMPLE_HEAD_KEEP_TOKENS,
    EXAMPLE_MESSAGES,
    buildCompactExample,
    bytesToTokens,
    type ExampleMessage,
} from "../../src/shared/context/compact-example";

/** 造一条样例消息（token 口径 = 字节 ÷ 4，保头 = 600 token = 2400 字节） */
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

describe("compact-example · 范例预览的模拟口径", () => {
    it("保头 = 600 token 硬编码（不是字节、不进配置）", () => {
        expect(EXAMPLE_HEAD_KEEP_TOKENS).toBe(600);
        expect(bytesToTokens(EXAMPLE_HEAD_KEEP_TOKENS * 4)).toBe(600);
    });

    it("保头：装到超过 600 token 为止，首个 user 一定在内", () => {
        const r = buildCompactExample(0, [m("u", 1000, "user"), m("a", 1000), m("b", 1000), m("c", 1000)]);
        expect(r.headEnd).toBe(2); // 1000+1000+1000 = 3000 ≥ 2400 ⇒ 停在第三条
        expect(r.rows[0].kept).toBe(true);
        expect(r.rows[0].why).toContain("保头");
    });

    it("上限 0 = 清零：只剩保头，其余全丢", () => {
        // 5 条 × 1000 字节：保头吃掉前 3 条（2400 字节 = 600 token）
        const r = buildCompactExample(0, [m("u", 1000, "user"), m("a", 1000), m("b", 1000), m("c", 1000), m("d", 1000)]);
        expect(r.rows.map((x) => x.kept)).toEqual([true, true, true, false, false]);
        expect(r.dropped).toBe(2);
        expect(r.rows[3].why).toContain("清零");
    });

    it("从最后往前累加：累积 ≥ 上限即停（刚越过上限那条算保留）", () => {
        const msgs = [m("u", 1000, "user"), m("a", 1000), m("b", 1000), m("c", 1000), m("d", 1000)];
        const r = buildCompactExample(500, msgs);
        // 尾部 1000 字节已 ≥ 500 ⇒ 只取最后一条
        expect(r.cut).toBe(4);
        expect(r.rows.map((x) => x.kept)).toEqual([true, true, true, false, true]);
        expect(r.dropped).toBe(1);
        expect(r.biggestDrop?.id).toBe("c");
    });

    it("上限很大 ⇒ 一条不丢（保头与尾部接上）", () => {
        const msgs = [m("u", 1000, "user"), m("a", 1000), m("b", 1000)];
        const r = buildCompactExample(100_000, msgs);
        expect(r.dropped).toBe(0);
        expect(r.keptBytes).toBe(r.beforeBytes);
    });

    it("tool 配对：留了 result 就必须把它的 call 留住（切点往前挪）", () => {
        const msgs = [
            m("u", 2000, "user"),
            m("call1", 500, "call", "c1"),
            m("res1", 500, "result", "c1"),
            m("text", 500),
            m("call2", 500, "call", "c2"),
            m("res2", 500, "result", "c2"),
        ];
        // 上限 500 ⇒ 本来只切到最后一条 result2；配对平衡把 call2 一起带进来
        const r = buildCompactExample(500, msgs);
        expect(r.rows.find((x) => x.id === "call2")?.kept).toBe(true);
        expect(r.rows.find((x) => x.id === "res2")?.kept).toBe(true);
        expect(r.rows.find((x) => x.id === "text")?.kept).toBe(false);
    });

    it("自带样例：6 轮 / 20 条，压到 3 KB 时确实丢东西且主要砍工具结果", () => {
        expect(EXAMPLE_MESSAGES).toHaveLength(20);
        const r = buildCompactExample(3 * 1024);
        expect(r.beforeBytes).toBeGreaterThan(3 * 1024);
        expect(r.dropped).toBeGreaterThan(0);
        expect(r.keptBytes).toBeLessThan(r.beforeBytes);
        // 工具结果是最大块 ⇒ 主要被砍的是它（这也是样例故意做成不均匀的理由）
        expect(r.biggestDrop?.kind).toBe("result");
        // 保头永不丢
        expect(r.rows[0].kept).toBe(true);
        // 保留的字节一定 ≥ 保头字节
        expect(r.keptBytes).toBeGreaterThanOrEqual(EXAMPLE_HEAD_KEEP_TOKENS * 4);
    });
});
