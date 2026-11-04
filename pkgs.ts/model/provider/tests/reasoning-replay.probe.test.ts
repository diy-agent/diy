// reasoning-replay.probe.test.ts — 多步工具的第 2 步起，assistant 缺 reasoning_content ⇒ 整轮 400
//
// ═══════════════════════════════════════════════════════════════════════
// ① 现象
//    长会话跑到中途突然整轮失败，报：
//      `[invalid_request_error] The reasoning_content in the thinking mode must be passed
//       back to the API.`
//    证据：~/.diy/log/network/2026-10-21.jsonl（当天 11 次，10-20 另有 4 次，共 15 次）
//          session=local-projects_4_tasks_402-5540a17d5d55 · attempt=103 · reqBytes=384564
//    该会话共 786 条消息 / 140 步，其中 **185 条 assistant 带 tool-call 但没有 reasoning 块**。
//
// ② 根因
//    上游校验的是**每一条**带 tool_calls 的 assistant。三步叠在一起：
//      a. 模型不是每步都吐 reasoning（实测 31% 的 assistant 没有）⇒ 消息里就没有 reasoning part
//      b. @ai-sdk/openai-compatible 见 reasoning.length===0 ⇒ **wire 上连字段都不出现**
//      c. ##405 前半修只跑了**首步**的归一 —— 而第 2 步起 SDK 送上来的 assistant 是它用
//         响应重建的、不带 providerOptions。于是第 1~84 步全 200、第 85 步 400。
//
// ③ 修复
//    d9f63a06「thinking 回放归一跑到轮内每一步」
//    067c537f「无 think 块的 assistant 也带 reasoning_content」（##398）
//    14edb378「迁到 @diy-agent/llm-provider」—— 逻辑不再住在要废弃的 diy-app 里
//
// ④ 现在守什么
//    · 任何一条缺 reasoning 的 assistant 都必须被补 `openaiCompatible.reasoning_content = ""`
//    · **真的走到 wire 上**（不是只挂了字段 —— 消息级 providerOptions 透传是 SDK 实现细节）
//    · 有真思考的那条**绝不被覆盖**（换成空串比 400 更糟）
//    · 条数 / 下标不变（llm.jsonl 行号对齐语义）
//
// 留档策略：这条是**协议约束**（不是某次上游抽风），长期保留，不归档。
// ═══════════════════════════════════════════════════════════════════════

import { describe, expect, it, vi } from "vitest";
import { streamText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ensureReasoningReplay } from "../src/reasoning-replay.js";

/** 真实会话里的两种 assistant 形态（取自 projects_4_tasks_402） */
const withReasoning = (id: string): ModelMessage => ({
    role: "assistant",
    content: [
        { type: "reasoning", text: "先看看目录结构" },
        { type: "tool-call", toolCallId: id, toolName: "read", input: { path: "a.txt" } },
    ],
});

const withoutReasoning = (id: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { path: "a.txt" } }],
});

const toolResult = (id: string): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "内容" } }],
});

/**
 * 桩 fetch 接住**定稿 body**（照抄 diy-app `reasoning-replay.test.ts::captureWire` 的手法）。
 *
 * 为什么必须截 wire：纯函数单测只能证明「我们挂了字段」；消息级 providerOptions 能不能
 * 真的出现在 HTTP body 上，是 SDK 的实现细节 —— 升级可能变。这是唯一能证明修复有效的判据。
 */
async function captureWire(messages: ModelMessage[]): Promise<{ role: string; reasoning_content?: unknown }[]> {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    let captured: { messages: { role: string; reasoning_content?: unknown }[] } | null = null;
    const provider = createOpenAICompatible({
        name: "probe",
        baseURL: "http://127.0.0.1:1/unreachable",
        apiKey: "probe-no-key",
        transformRequestBody: (args) => {
            captured = args as unknown as { messages: { role: string; reasoning_content?: unknown }[] };
            return args;
        },
        fetch: (async () =>
            new Response(JSON.stringify({ error: { message: "captured" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
            })) as typeof fetch,
    });
    try {
        const r = streamText({ model: provider("deepseek-v4.1-flash"), messages, maxRetries: 0 });
        for await (const _ of r.fullStream) void _;
    } catch {
        /* 桩返回 400 ⇒ SDK 抛错，body 已到手 */
    }
    quiet.mockRestore();
    if (captured === null) throw new Error("没截到 wire body");
    return captured.messages;
}

describe("probe：多步会话第 N 步 400", () => {
    /** 造一段真实形状的多步历史：交替「有 reasoning / 无 reasoning」共 40 步 */
    function history(steps = 40): ModelMessage[] {
        const out: ModelMessage[] = [{ role: "user", content: "把这个仓库的测试跑一遍" }];
        for (let i = 0; i < steps; i += 1) {
            out.push(i % 2 === 0 ? withReasoning(`c${i}`) : withoutReasoning(`c${i}`));
            out.push(toolResult(`c${i}`));
        }
        return out;
    }

    it("【核心】不修 ⇒ 无 reasoning 的 assistant 在 wire 上缺字段；修后 ⇒ 每条都有", async () => {
        const msgs = history();
        // 不修：直接发 —— 模拟 bug 发生时的状态
        const broken = await captureWire(msgs);
        const brokenAssistants = broken.filter((m) => m.role === "assistant");
        const missing = brokenAssistants.filter((m) => m.reasoning_content === undefined);
        expect(missing.length, "对照组应当能看到「缺字段」的现象").toBeGreaterThan(0);

        // 修后：套 ensureReasoningReplay 再发
        const fixed = await captureWire(ensureReasoningReplay(msgs, { thinking: true, deepseek: true }));
        const fixedAssistants = fixed.filter((m) => m.role === "assistant");
        expect(fixedAssistants.length).toBe(brokenAssistants.length); // 条数不变
        for (const m of fixedAssistants) {
            expect(m.reasoning_content, "每条 assistant 在 wire 上都必须有 reasoning_content").toBeDefined();
        }
    });

    it("有真思考的那条：wire 上是**真内容**，不是被覆盖成空串", async () => {
        const msgs = [withReasoning("r1"), toolResult("r1")];
        const wire = await captureWire(ensureReasoningReplay(msgs, { thinking: true, deepseek: true }));
        const a = wire.find((m) => m.role === "assistant");
        expect(typeof a?.reasoning_content).toBe("string");
        expect(a?.reasoning_content).not.toBe("");
    });

    // 两条独立用例（不合并循环）：同一测试里连开两个 provider 时，第二个的
    // transformRequestBody 有时接不到 wire（SDK 内部对同 shape 请求有缓存），分开更稳。
    it("非 thinking ⇒ 不补", async () => {
        const msgs: ModelMessage[] = [
            { role: "user", content: "读一下 a.txt" },
            withoutReasoning("x1"),
            toolResult("x1"), // tool-call 必须配对，否则 SDK 在 fetch 前就拒绝
        ];
        const wire = await captureWire(ensureReasoningReplay(msgs, { thinking: false, deepseek: true }));
        expect(wire.find((m) => m.role === "assistant")?.reasoning_content).toBeUndefined();
    });

    it("非 deepseek ⇒ 不补（空串是否被接受只有 deepseek 有证据）", async () => {
        const msgs: ModelMessage[] = [
            { role: "user", content: "读一下 a.txt" },
            withoutReasoning("x2"),
            toolResult("x2"),
        ];
        const wire = await captureWire(ensureReasoningReplay(msgs, { thinking: true, deepseek: false }));
        expect(wire.find((m) => m.role === "assistant")?.reasoning_content).toBeUndefined();
    });
});
