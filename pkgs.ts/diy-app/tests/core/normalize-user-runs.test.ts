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

    it("信封形态的 user 不参与合并（##421）：自动段与历史首条 user 各占一条", () => {
        // 自动段自占顶层键（`summary:`；`history:` 注记已于 ##442 刀 2 删除）——
        // 若被并进相邻 user，`user.message` 就变成「自动段 + 原话」一坨
        const note = 'summary: "上一段结论"';
        const out = normalizeUserRuns([
            { role: "user", content: note },
            { role: "user", content: "用户原话" },
        ] as ModelMessage[]);
        expect(out).toHaveLength(2);
        expect(out[0]!.content).toBe(note);
        expect(out[1]!.content).toBe("用户原话");
    });

    it("信封形态的尾部 envelope 也不参与合并（runtime / user 两段自己拼好的一份）", () => {
        const env = 'runtime:\n  task:\n    body: x\nuser:\n  message: "本轮"';
        const out = normalizeUserRuns([
            { role: "user", content: "上一句" },
            { role: "user", content: env },
        ] as ModelMessage[]);
        expect(out).toHaveLength(2);
        expect(out[1]!.content).toBe(env);
    });

    it("普通正文碰巧首行像键（有缩进 / 不在白名单）→ 照旧合并", () => {
        const out = normalizeUserRuns([
            { role: "user", content: "  前半句：缩进" },
            { role: "user", content: "后半句" },
        ] as ModelMessage[]);
        expect(out).toHaveLength(1);
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
