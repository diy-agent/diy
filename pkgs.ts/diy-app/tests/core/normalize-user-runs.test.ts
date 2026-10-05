// tests/core/normalize-user-runs.test.ts
// 🎯 投递前合并相邻 user 消息（防连续同角色消息在不严格的 provider 下报错/被丢弃）
import { describe, it, expect } from "vitest";
import { normalizeUserRuns } from "../../src/main/services/local-agent";
import type { ModelMessage } from "ai";

describe("normalizeUserRuns", () => {
    it("两条相邻纯文本 user → 合并成一条（换行分隔）", () => {
        const out = normalizeUserRuns([
            { role: "user", content: "摘要" },
            { role: "user", content: "本轮输入" },
        ] as ModelMessage[]);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({ role: "user", content: "摘要\n本轮输入" });
    });

    it("user ↔ assistant 交替：不动", () => {
        const msgs = [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
        ] as ModelMessage[];
        expect(normalizeUserRuns(msgs)).toEqual(msgs);
    });

    it("含 part 数组的相邻 user → content 变 part 数组（用户示例的形态）", () => {
        const out = normalizeUserRuns([
            { role: "user", content: [{ type: "text", text: "A" }] },
            { role: "user", content: [{ type: "text", text: "B" }] },
        ] as ModelMessage[]);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "A" },
                { type: "text", text: "B" },
            ],
        });
    });

    it("字符串 + part 数组混排 → 归一成 part 数组", () => {
        const out = normalizeUserRuns([
            { role: "user", content: "A" },
            { role: "user", content: [{ type: "text", text: "B" }] },
        ] as ModelMessage[]);
        expect(out[0]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "A" },
                { type: "text", text: "B" },
            ],
        });
    });

    it("三段连续 user → 合成一条", () => {
        const out = normalizeUserRuns([
            { role: "user", content: "1" },
            { role: "user", content: "2" },
            { role: "user", content: "3" },
        ] as ModelMessage[]);
        expect(out).toHaveLength(1);
        expect(out[0]!.content).toBe("1\n2\n3");
    });

    it("不碰 tool 消息与配对（tool-call / tool-result 原样）", () => {
        const msgs = [
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "bash", input: {} }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "bash", output: { type: "text", value: "r" } }] },
            { role: "user", content: "x" },
        ] as unknown as ModelMessage[];
        expect(normalizeUserRuns(msgs)).toEqual(msgs);
    });
});
