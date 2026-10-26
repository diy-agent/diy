import { describe, expect, it } from "vitest";
import {
    HEAD_KEEP_TOKENS,
    hasDropped,
    selectKeptBoundary,
    type BoundaryMessage,
} from "../../src/shared/context/select-kept-boundary";

/** 造一条消息（边界只关心 tokens 与工具配对） */
function m(tokens: number, kind?: string, callId?: string): BoundaryMessage {
    return { tokens, ...(kind ? { kind } : {}), ...(callId ? { callId } : {}) };
}

// 本文件是 `selectKeptBoundary` 的**唯一**判据测试：其他调用方（范例预览等）只测「有没有走这个函数」，
// 不许各自复制一份算法断言 —— 否则锁死两份实现。##432 落地后本文件随实现一起迁移。
describe("select-kept-boundary · 保留边界的唯一判据", () => {
    it("保头 = 600 token 硬编码", () => {
        expect(HEAD_KEEP_TOKENS).toBe(600);
    });

    it("保头：从第一条起装到 ≥ 600 token 为止", () => {
        // 250 × 3 = 750 ≥ 600 ⇒ 停在第三条（下标 2）
        const { headEnd } = selectKeptBoundary([m(250), m(250), m(250), m(250)], 0);
        expect(headEnd).toBe(2);
    });

    it("首个 user 永不被丢：单条就超过 600 token 时保头也含它", () => {
        const { headEnd } = selectKeptBoundary([m(5000), m(100)], 0);
        expect(headEnd).toBe(0);
    });

    it("上限 0 = 清零：尾部一条都不取（cut = 条数）", () => {
        const { headEnd, cut } = selectKeptBoundary([m(250), m(250), m(250), m(250), m(250)], 0);
        expect(headEnd).toBe(2);
        expect(cut).toBe(5);
    });

    it("从最后往前累加、**先判再加**：保留到上限的一半（RETAIN_RATIO），最后一步永远保留", () => {
        // 每条 250 token、上限 125 ⇒ 尾部额度 floor(62.5)−保头(750) ≤ 0 ⇒ 只留最后一条
        const { cut } = selectKeptBoundary([m(250), m(250), m(250), m(250), m(250)], 125);
        expect(cut).toBe(4);
    });

    it("上限足够大 ⇒ 保头与尾部接上（cut = headEnd + 1，一条不丢）", () => {
        const { headEnd, cut } = selectKeptBoundary([m(250), m(250), m(250)], 100_000);
        expect(cut).toBe(headEnd + 1);
    });

    it("tool 配对平衡：留了 result 就必须留下它的 call（切点往前挪）", () => {
        const msgs = [
            m(500), // 保头区（500 ≥ … 第一条先吃）
            m(125, "call", "c1"),
            m(125, "result", "c1"),
            m(125),
            m(125, "call", "c2"),
            m(125, "result", "c2"),
        ];
        // 上限 125 ⇒ 本来只切到最后一条 result(c2)；配平把 call(c2) 一起带进来
        const { cut } = selectKeptBoundary(msgs, 125);
        expect(cut).toBe(4);
        expect(msgs[cut].kind).toBe("call");
    });

    it("**多 tool-call 一条消息**：切点落在第二个 result 上也必须配平（review P0-1）", () => {
        // 一条 assistant 消息带 A、B 两个工具调用（并行调用是常态）
        const call2: BoundaryMessage = { tokens: 125, kind: "call", callIds: ["cA", "cB"] };
        // 末条是 result(cB) ⇒ 切点本来就落在它身上（保留区会从一条孤立 result 开始）；
        // 中间两段是正常历史（保证配平后确实丢了东西）
        const msgs = [m(600), m(300), m(300), call2, m(125, "result", "cA"), m(125, "result", "cB")];
        // 上限 125 ⇒ 本可只切到最后一条 result(cB)；配平必须前移到那条带 cB 的调用
        const { cut, kind, dropped } = selectKeptBoundary(msgs, 125);
        expect(msgs[cut]).toBe(call2); // 前移到**带 cA/cB 的那条调用**（不是停在孤立 result 上）
        expect(kind).toBe("drop");
        expect(dropped).toBe(2);
        // 保留区里不得出现「无主的 result」
        const kept = msgs.slice(cut);
        const keptIds = new Set(kept.flatMap((x) => x.callIds ?? (x.callId ? [x.callId] : [])));
        for (const x of kept) {
            if (x.kind === "result" && x.callId) expect(keptIds.has(x.callId)).toBe(true);
        }
    });

    it("显式状态：`cut === n`（全丢）也是 drop，不是 none（review P1-2）", () => {
        const full = selectKeptBoundary([m(250), m(250), m(250), m(250), m(250)], 0);
        expect(full.cut).toBe(5);
        expect(full.kind).toBe("drop");
        expect(full.dropped).toBe(2); // 保头 3 条之外全丢
        expect(hasDropped(full)).toBe(true);

        const none = selectKeptBoundary([m(250), m(250), m(250)], 100_000);
        expect(none.kind).toBe("none");
        expect(none.dropped).toBe(0);
        expect(hasDropped(none)).toBe(false);
    });

    it("limits 极小 ⇒ 只留保头 + 最新一组（不越界、不返回负 dropped）", () => {
        const msgs = Array.from({ length: 12 }, (_, i) => ({ tokens: 500, step: `s${i}` }) as BoundaryMessage);
        const { headEnd, cut, dropped, kind } = selectKeptBoundary(msgs, 1);
        expect(headEnd).toBe(1); // 500 + 500 ≥ 600
        expect(cut).toBe(11); // 最后一组永远保留
        expect(dropped).toBe(9);
        expect(kind).toBe("drop");
    });

    it("配平不会越过保头（切点至少停在 headEnd + 1）", () => {
        const msgs = [m(1000), m(50, "call", "c1"), m(50, "result", "c1")];
        const { headEnd, cut } = selectKeptBoundary(msgs, 10);
        expect(headEnd).toBe(0);
        expect(cut).toBeGreaterThanOrEqual(headEnd + 1);
    });
});
