// tests/core/context-step-request.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 一条真发请求 → 它的 messages[]（上下文树「该步实际请求」view 的唯一数据源）。
//
// 口径：
//   · 只认 messages（不要请求头 / 工具定义）；
//   · 格式化视图与 `<>` 原始视图**同源**（一次解析），否则"渲染的 ≠ 原文的"无法自证；
//   · 请求体不可用（缺席 / 截断解不开 / 没有 messages）→ 一律 null + 说明，**不编**。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { estimateTokens, parseStepRequest } from "../../src/shared/context/step-request";

const body = (messages: unknown, over: Partial<{ truncated: boolean; totalBytes: number }> = {}) => ({
    head: JSON.stringify({ model: "x", messages }),
    truncated: false,
    ...over,
});

describe("parseStepRequest：请求 → 消息", () => {
    it("★ 逐条给出 role / 正文 / 体积 / token 估算，并给同源的原始 JSON", () => {
        const messages = [
            { role: "system", content: "你是助手" },
            { role: "user", content: "看看这个" },
        ];
        const r = parseStepRequest(body(messages));
        expect(r.note).toBe("");
        expect(r.messages).toHaveLength(2);
        expect(r.messages![0]).toMatchObject({ index: 1, role: "system", text: "你是助手" });
        expect(r.messages![1]).toMatchObject({ index: 2, role: "user", text: "看看这个" });
        expect(r.totalChars).toBe("你是助手看看这个".length);
        expect(r.totalTokens).toBeGreaterThan(0);
        // 原始视图 = messages 数组本身（不含 model 等其它键）
        expect(JSON.parse(r.raw!)).toEqual(messages);
    });

    it("★ tool-call 分片被摘出来（名字 + 参数长度），正文只留一行摘要", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "我查一下" },
                    { type: "tool-call", toolName: "read_file", input: { path: "/a/b.ts" } },
                ],
            },
        ];
        const r = parseStepRequest(body(messages));
        const m = r.messages![0]!;
        expect(m.toolCalls).toHaveLength(1);
        expect(m.toolCalls[0]!.name).toBe("read_file");
        expect(m.toolCalls[0]!.argsChars).toBe(JSON.stringify({ path: "/a/b.ts" }).length);
        expect(m.text).toContain("我查一下");
        expect(m.text).toContain("[tool-call read_file]");
    });

    it("tool-result 的大输出被截到预览（不把 payload 糊满屏）", () => {
        const big = "x".repeat(1000);
        const r = parseStepRequest(body([{ role: "tool", content: [{ type: "tool-result", output: big }] }]));
        const m = r.messages![0]!;
        expect(m.text.length).toBeLessThan(300);
        expect(m.text).toContain("共 1000 字");
    });

    it("请求体缺席 → null + 说明（不编）", () => {
        const r = parseStepRequest(null);
        expect(r.messages).toBeNull();
        expect(r.raw).toBeNull();
        expect(r.note).not.toBe("");
    });

    it("截断解不开 → null，且说明指向「记录完整请求内容」开关", () => {
        const r = parseStepRequest({ head: '{"messages":[{"role":"u', truncated: true, totalBytes: 90000 });
        expect(r.messages).toBeNull();
        expect(r.note).toContain("截断");
        expect(r.note).toContain("记录完整请求内容");
    });

    it("有 JSON 但没有 messages 数组 → null + 说明（可能是摘要 / 探测请求）", () => {
        const r = parseStepRequest({ head: JSON.stringify({ model: "x" }) });
        expect(r.messages).toBeNull();
        expect(r.note).toContain("messages");
    });

    it("每条的字节数含 tool_calls（回答「哪条撑爆了上下文」）", () => {
        const r = parseStepRequest(
            body([{ role: "assistant", content: [{ type: "tool-call", toolName: "t", input: { a: "y".repeat(500) } }] }]),
        );
        expect(r.messages![0]!.bytes).toBeGreaterThan(500);
    });
});

describe("estimateTokens：CJK 按 1、其余按 1/4", () => {
    it("中文不会被 bytes/4 低估", () => {
        // 8 个汉字 = 24 字节；bytes/4 会估成 6，实际约 8
        expect(estimateTokens("上下文变量树投影")).toBe(8);
    });
    it("英文按 4 字符 1 token", () => {
        expect(estimateTokens("abcdefgh")).toBe(2);
    });
    it("混排按两类分别折算后取整", () => {
        expect(estimateTokens("中文abcd")).toBe(3); // 2 + 4/4
    });
});
