// reasoning-replay.test.ts — thinking 模式下 assistant 必须带 reasoning_content
//
// 上游铁律（真实 15 次 400，见 fixture `reasoning-not-passed.gen.ts`）：
//   `[invalid_request_error] The reasoning_content in the thinking mode must be passed back to the API.`
//
// 这条逻辑原本只在 apps/diy-app（要废弃）里，迁到本包后新架构（apps/chat）才守得住。
// 消息形状取自真实会话 `projects_4_tasks_402`（786 行 / 140 步）：其中 185 条 assistant
// 带 tool-call 但**没有 reasoning** —— 那就是 400 的原型。

import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { ensureReasoningReplay, isDeepSeekWire } from "../src/reasoning-replay.js";

const assistantToolCall = (id: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { path: "a.txt" } }],
});

const assistantWithReasoning = (id: string): ModelMessage => ({
    role: "assistant",
    content: [
        { type: "reasoning", text: "先读文件" },
        { type: "tool-call", toolCallId: id, toolName: "read", input: { path: "a.txt" } },
    ],
});

describe("isDeepSeekWire", () => {
    it("三项任一含 deepseek 即算（provider / model / baseUrl）", () => {
        expect(isDeepSeekWire({ provider: "deepseek" })).toBe(true);
        expect(isDeepSeekWire({ model: "deepseek-v4.1-flash" })).toBe(true);
        expect(isDeepSeekWire({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
    });

    it("glm / 其它 reasoning 模型不算（空串是否被接受只有 deepseek 有证据）", () => {
        expect(isDeepSeekWire({ provider: "opencode-go", model: "glm-5.3", baseUrl: "https://opencode.ai/x" })).toBe(false);
    });
});

describe("ensureReasoningReplay", () => {
    const opts = { thinking: true, deepseek: true };

    it("无 reasoning 的 assistant ⇒ 补空串", () => {
        const out = ensureReasoningReplay([assistantToolCall("c1")], opts);
        expect(out).toHaveLength(1);
        expect((out[0] as { providerOptions?: unknown }).providerOptions).toEqual({
            openaiCompatible: { reasoning_content: "" },
        });
    });

    it("有 reasoning part ⇒ **绝不覆盖**（覆盖 = 把真思考换成空串，比 400 更糟）", () => {
        const msg = assistantWithReasoning("c2");
        const out = ensureReasoningReplay([msg], opts);
        expect(out[0]).toBe(msg); // 同一引用
    });

    it("非 thinking 或 非 deepseek ⇒ 原样返回同一数组引用", () => {
        const msgs = [assistantToolCall("c3")];
        expect(ensureReasoningReplay(msgs, { thinking: false, deepseek: true })).toBe(msgs);
        expect(ensureReasoningReplay(msgs, { thinking: true, deepseek: false })).toBe(msgs);
    });

    it("幂等：已补过的再跑不变（同引用）—— prepareStep 每步都会调", () => {
        const once = ensureReasoningReplay([assistantToolCall("c4")], opts);
        const twice = ensureReasoningReplay(once, opts);
        expect(twice).toBe(once);
    });

    it("真实形状：多步会话里 185 条无 reasoning 的 assistant 全被补齐，且条数/下标不变", () => {
        // 按真实会话的比例造 40 步：奇偶交替（有 reasoning / 无 reasoning）
        const msgs: ModelMessage[] = [];
        for (let i = 0; i < 40; i += 1) {
            msgs.push(i % 2 === 0 ? assistantWithReasoning(`c${i}`) : assistantToolCall(`c${i}`));
            msgs.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read", output: { type: "text", value: "x" } }] });
        }
        const out = ensureReasoningReplay(msgs, opts);
        expect(out).toHaveLength(msgs.length); // 条数不变
        for (let i = 0; i < out.length; i += 1) {
            const m = out[i] as { role: string; providerOptions?: { openaiCompatible?: { reasoning_content?: string } } };
            if (m.role !== "assistant") continue;
            if (i % 4 === 0) {
                // 有 reasoning 的那条：不该被塞 metadata（真思考由 part 承载）
                expect(m.providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined();
            } else {
                expect(m.providerOptions?.openaiCompatible?.reasoning_content).toBe("");
            }
        }
    });
});
