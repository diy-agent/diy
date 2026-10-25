import { describe, expect, it } from "vitest";
import {
    HEAD_KEEP_TOKENS,
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

    it("配平不会越过保头（切点至少停在 headEnd + 1）", () => {
        const msgs = [m(1000), m(50, "call", "c1"), m(50, "result", "c1")];
        const { headEnd, cut } = selectKeptBoundary(msgs, 10);
        expect(headEnd).toBe(0);
        expect(cut).toBeGreaterThanOrEqual(headEnd + 1);
    });
});
