// tests/core/reasoning-replay.test.ts
// 🎯 thinking 回放归一（##398）：缺 reasoning 的 assistant 消息补 `reasoning_content: ""`
//
// 三态 + 下标/条数不变 + **wire 截获反证**（真跑一次 SDK 组装链、用桩 fetch 接住定稿 body）——
// 纯函数单测只能证明"我们挂了字段"，只有截住 wire 才能证明 **SDK 真的把它发出去了**
// （消息级 providerOptions 透传是 SDK 的实现细节，升级可能变）。
import { describe, it, expect, vi } from "vitest";
import { streamText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ensureReasoningReplay, isDeepSeekWire } from "../../src/main/services/reasoning-replay";
import { reasoningReplayOptsOf } from "../../src/main/services/local-agent";
import type { ResolvedModel } from "../../src/shared/models";

/** 历史里的典型形状：带 tool-call 但**没有** reasoning part（31% 的 assistant 长这样） */
const assistantToolCall = (id: string): ModelMessage =>
    ({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { command: "ls" } }],
    }) as ModelMessage;

const assistantWithReasoning = (id: string): ModelMessage =>
    ({
        role: "assistant",
        content: [
            { type: "reasoning", text: "THINKING" },
            { type: "tool-call", toolCallId: id, toolName: "bash", input: { command: "ls" } },
        ],
    }) as ModelMessage;

const history = (): ModelMessage[] => [
    { role: "user", content: "hi" },
    assistantToolCall("c1"),
    {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }],
    },
    assistantWithReasoning("c2"),
    {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c2", toolName: "bash", output: { type: "text", value: "ok" } }],
    },
];

describe("isDeepSeekWire（收窄判据，照抄 opencode / pi）", () => {
    it("model id 含 deepseek ⇒ true（opencode 的 modelID.includes）", () => {
        expect(isDeepSeekWire({ provider: "opencode-go", model: "deepseek-v4.1-flash" })).toBe(true);
    });
    it("provider 含 deepseek ⇒ true", () => {
        expect(isDeepSeekWire({ provider: "deepseek", model: "v4.1-flash" })).toBe(true);
    });
    it("baseUrl 含 deepseek ⇒ true", () => {
        expect(isDeepSeekWire({ baseUrl: "https://api.deepseek.com/v1", model: "v4" })).toBe(true);
    });
    it("glm / 其它 reasoning 模型 ⇒ false（没验过空串被接受，不许放宽）", () => {
        expect(
            isDeepSeekWire({ provider: "opencode-go", model: "glm-5.2", baseUrl: "https://opencode.ai/zen/go/v1" }),
        ).toBe(false);
    });
});

describe("ensureReasoningReplay", () => {
    it('① 无 reasoning part ⇒ 补 openaiCompatible.reasoning_content = ""', () => {
        const out = ensureReasoningReplay([assistantToolCall("c1")], { thinking: true, deepseek: true });
        expect(out[0]).toEqual({
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }],
            providerOptions: { openaiCompatible: { reasoning_content: "" } },
        });
    });

    it("② 有 reasoning part ⇒ 原样（绝不覆盖真思考）", () => {
        const m = assistantWithReasoning("c1");
        const out = ensureReasoningReplay([m], { thinking: true, deepseek: true });
        expect(out[0]).toBe(m); // 同一个对象：连浅拷贝都没做
        expect((out[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    });

    it("③ 非 thinking ⇒ 不动（返回同一数组引用）", () => {
        const msgs = history();
        expect(ensureReasoningReplay(msgs, { thinking: false, deepseek: true })).toBe(msgs);
    });

    it("④ 非 deepseek ⇒ 不动（glm 等未验证空串）", () => {
        const msgs = history();
        expect(ensureReasoningReplay(msgs, { thinking: true, deepseek: false })).toBe(msgs);
    });

    it("⑤ 条数 / 顺序 / 下标不变，非 assistant 消息一个字节都不碰", () => {
        const msgs = history();
        const out = ensureReasoningReplay(msgs, { thinking: true, deepseek: true });
        expect(out).toHaveLength(msgs.length);
        msgs.forEach((m, i) => {
            expect(out[i]!.role).toBe(m.role);
            if (m.role !== "assistant") expect(out[i]).toBe(m);
            // 下标语义 = llm.jsonl 行号（##371 铁律）：位置一律不动
            expect(out[i]!.content).toEqual(m.content);
        });
        // 只有缺 reasoning 的那条被补（第 2 条），有 reasoning 的第 4 条不补
        expect((out[1] as { providerOptions?: unknown }).providerOptions).toEqual({
            openaiCompatible: { reasoning_content: "" },
        });
        expect((out[3] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    });

    it("⑥ 已有其它 providerOptions（含 openaiCompatible 的别的键）⇒ 合并、不丢", () => {
        const m = {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }],
            providerOptions: { openai: { foo: 1 }, openaiCompatible: { bar: 2 } },
        } as unknown as ModelMessage;
        const out = ensureReasoningReplay([m], { thinking: true, deepseek: true });
        expect((out[0] as { providerOptions?: unknown }).providerOptions).toEqual({
            openai: { foo: 1 },
            openaiCompatible: { bar: 2, reasoning_content: "" },
        });
    });
});

// ── wire 截获（确定性判据）：真跑 SDK 组装链，桩 fetch 接住定稿 body ──
async function captureWire(messages: ModelMessage[]): Promise<{ role: string; reasoning_content?: unknown }[]> {
    // 桩返回 400 会让 SDK console.error 打印整份 body —— 本测试故意撞错，噪声无意义
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    let captured: Record<string, unknown> | null = null;
    const provider = createOpenAICompatible({
        name: "probe",
        baseURL: "http://127.0.0.1:1/unreachable",
        apiKey: "probe-no-key",
        transformRequestBody: (args) => {
            captured = args as Record<string, unknown>;
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
        for await (const part of r.fullStream) void part;
    } catch {
        /* 桩返回 400 ⇒ SDK 抛错，body 已到手 */
    }
    quiet.mockRestore();
    expect(captured).not.toBeNull();
    return (captured as unknown as { messages: { role: string; reasoning_content?: unknown }[] }).messages;
}

describe("wire 截获（SDK 真的把补丁发出去）", () => {
    it('开归一 ⇒ wire 上缺 reasoning 的 assistant 带 reasoning_content:""，有 reasoning 的不被覆盖', async () => {
        const msgs = ensureReasoningReplay(history(), { thinking: true, deepseek: true });
        const wire = await captureWire(msgs);
        const assistants = wire.filter((m) => m.role === "assistant");
        expect(assistants).toHaveLength(2);
        // ① 补了空串（SDK 的 assistant 分支平时连这个字段都不输出）
        expect(assistants[0]!["reasoning_content"]).toBe("");
        // ② 真思考原样回传
        expect(assistants[1]!["reasoning_content"]).toBe("THINKING");
    });

    it("反证：关掉归一（thinking=false）⇒ wire 上该字段压根不出现（这就是修前的 400 形状）", async () => {
        const msgs = ensureReasoningReplay(history(), { thinking: false, deepseek: true });
        const wire = await captureWire(msgs);
        const assistants = wire.filter((m) => m.role === "assistant");
        expect(assistants).toHaveLength(2);
        expect("reasoning_content" in assistants[0]!).toBe(false);
        expect(assistants[1]!["reasoning_content"]).toBe("THINKING");
    });
});

// ── 开关判据（reasoningReplayOptsOf）：thinking = 档位非 none **且模型支持该档**；只对 chat 面 ──
describe("reasoningReplayOptsOf（什么时候补）", () => {
    const mk = (over: Partial<ResolvedModel>): ResolvedModel => ({
        id: "deepseek-v4.1-flash",
        name: "DS",
        api: "chat",
        reasoning: { supported: ["default", "none", "low", "medium", "high"], default: "medium" },
        ref: "0@opencode-go/deepseek-v4.1-flash",
        provider: "opencode-go",
        kind: "std",
        account: "0",
        baseUrl: "https://opencode.ai/inference/go/v1",
        npm: "@ai-sdk/openai-compatible",
        key: "k",
        ...over,
    });
    it("deepseek + 支持 high ⇒ 两个开关都开", () => {
        expect(reasoningReplayOptsOf(mk({}), "high")).toEqual({ thinking: true, deepseek: true });
    });

    it("档位 none ⇒ 不动（唯一显式关掉思考的语义）", () => {
        expect(reasoningReplayOptsOf(mk({}), "none")).toEqual({ thinking: false, deepseek: true });
    });

    it("default（平台默认）⇒ 仍算 thinking（那只是不发档位参数，不是关掉思考）", () => {
        expect(reasoningReplayOptsOf(mk({}), "default")).toEqual({ thinking: true, deepseek: true });
    });

    it("档位不在模型词表里（手写 personas）⇒ 仍补：真发并不校验 supported，收窄会漏补", () => {
        expect(reasoningReplayOptsOf(mk({}), "xhigh")).toEqual({ thinking: true, deepseek: true });
    });

    it("responses 面 ⇒ 不动（providerOptions.openaiCompatible 到不了 wire）", () => {
        expect(reasoningReplayOptsOf(mk({ api: "responses" }), "high")).toEqual({ thinking: true, deepseek: false });
    });

    it("glm（非 deepseek）⇒ 不动，即使 thinking", () => {
        expect(reasoningReplayOptsOf(mk({ id: "glm-5.2", name: "GLM", ref: "0@opencode-go/glm-5.2" }), "high")).toEqual(
            {
                thinking: true,
                deepseek: false,
            },
        );
    });
});
