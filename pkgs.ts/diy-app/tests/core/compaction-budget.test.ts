// tests/core/compaction-budget.test.ts
// 🎯 预算驱动的历史选择（用户 2026-10-07「目标式压缩」）——
//    纵向优先级阶梯、配对铁律、清零、连续区间汇总。

import { describe, it, expect } from "vitest";
import { selectHistoryByBudget, HISTORY_LADDER } from "../../src/main/services/local-blocks";
import type { LocalModelMessage } from "../../src/main/services/local-blocks";
import { utf8Bytes } from "../../src/shared/context/compaction";

const user = (t: string, text: string): LocalModelMessage => ({ role: "user", content: text, turn: t });
const text = (t: string, s: string): LocalModelMessage => ({ role: "assistant", content: [{ type: "text", text: s }], turn: t });
const call = (t: string, id: string): LocalModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: {} }],
    turn: t,
});
const result = (t: string, id: string, v: string): LocalModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: v } }],
    turn: t,
});

/** 单条消息的**投递**字节 —— 与 renderMessage 同口径（真发不带 turn/step 索引位） */
const bytesOf = (m: LocalModelMessage): number => utf8Bytes(JSON.stringify({ role: m.role, content: m.content }));

describe("selectHistoryByBudget — 阶梯是纵向的（全局按类型，新的先）", () => {
    // 0 user(t1) 1 call(t1) 2 result(t1) 3 text(t1=结论) 4 user(t2) 5 text(t2=结论)
    const all: LocalModelMessage[] = [
        user("t1", "u1"),
        call("t1", "c1"),
        result("t1", "c1", "r1"),
        text("t1", "a1"),
        user("t2", "u2"),
        text("t2", "a2"),
    ];

    it("budget=0 → 全部丢弃（等价清零）", () => {
        const s = selectHistoryByBudget(all, 0);
        expect(s.kept).toEqual([]);
        expect(s.dropped).toEqual([0, 1, 2, 3, 4, 5]);
        expect(s.keptRuns).toEqual([]);
    });

    it("阶梯常量：user > conclusion > text > call > result", () => {
        expect(HISTORY_LADDER).toEqual(["user", "conclusion", "text", "call", "result"]);
    });

    it("先满足 user（主干），且同层新的先", () => {
        const s = selectHistoryByBudget(all, bytesOf(all[4]!));
        expect(s.kept).toEqual([4]); // 只有最新的 user 放得下
    });

    it("user 够了再往前拿更旧的 user；结论次之", () => {
        const budget = bytesOf(all[4]!) + bytesOf(all[0]!);
        const s = selectHistoryByBudget(all, budget);
        expect(s.kept).toEqual([0, 4]);
    });

    it("结果从不单独保留：call 与其 result 同进退（不够就一起丢）", () => {
        const only: LocalModelMessage[] = [call("t1", "c1"), result("t1", "c1", "r1")];
        // budget 只够 call 本身、不够 result → 两者都丢（不出现孤儿 call / 孤儿 result）
        const s = selectHistoryByBudget(only, bytesOf(only[0]!));
        expect(s.kept).toEqual([]);
    });

    it("call+result 一起计费时放得下 → 两条都在（result 不会单独留）", () => {
        const only: LocalModelMessage[] = [call("t1", "c1"), result("t1", "c1", "r1")];
        const s = selectHistoryByBudget(only, bytesOf(only[0]!) + bytesOf(only[1]!));
        expect(s.kept).toEqual([0, 1]);
        expect(s.keptRuns).toEqual([[1, 2]]);
    });

    it("大预算（>= 全部）→ 全保留，keptRuns 单区间", () => {
        const total = all.reduce((n, m) => n + bytesOf(m), 0);
        const s = selectHistoryByBudget(all, total);
        expect(s.kept).toEqual([0, 1, 2, 3, 4, 5]);
        expect(s.keptRuns).toEqual([[1, 6]]);
        expect(s.keptBytes).toBe(total);
    });
});

describe("selectHistoryByBudget — 连续区间与结论识别", () => {
    it("保留分散 → keptRuns 反映空格（gap 自明，不必逐 gap 标注）", () => {
        // 6 条 user，只留最新 2 条 → 下标 4,5 连续
        const all = [0, 1, 2, 3, 4, 5].map((i) => user(`t${i}`, `u${i}`));
        const s = selectHistoryByBudget(all, bytesOf(all[5]!) + bytesOf(all[4]!));
        expect(s.kept).toEqual([4, 5]);
        expect(s.keptRuns).toEqual([[5, 6]]);
    });

    it("每轮只把**最后一条**助手文本当结论（过程文本优先级更低）", () => {
        // t1: 超大 user（占满则不入）、过程文本、结论文本 —— 过程文本（text）应先于结论（conclusion）被丢
        const all: LocalModelMessage[] = [
            user("t1", "x".repeat(500)),
            text("t1", "过程：我先看看"),
            text("t1", "结论：答案是 42"),
        ];
        // 预算只够 1 条助手文本 → 应保留最后那条（结论），过程文本被丢
        const s = selectHistoryByBudget(all, bytesOf(all[2]!));
        expect(s.kept).toEqual([2]);
    });
});
