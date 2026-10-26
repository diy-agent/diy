// tests/core/tool-result-guard.test.ts
// 🎯 tool 配对兜底（##445）：assistant 的 tool-call 缺 result ⇒ 补占位，而不是让 SDK 抛
//
// 病灶（##444，2026-10-26 15:54Z）：`AI_MissingToolResultsError` 在
// `convertToLanguageModelPrompt` 本地抛出 —— 请求根本没发出去（流量日志 97 条全 200），
// 整轮被打死。故这里既有**纯函数**断言（补了、补齐几处、健康历史一个引用都不换），
// 也有 **SDK 真跑**的反证（不补就抛、补了就不抛且 wire 上有那条占位）。
import { describe, it, expect, vi } from "vitest";
import { streamText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ensureToolResultPairs, scanToolResultPairs, MISSING_TOOL_RESULT_NOTICE } from "../../src/main/services/tool-result-guard";

const user = (t: string): ModelMessage => ({ role: "user", content: t });

const assistantCall = (...ids: string[]): ModelMessage =>
    ({
        role: "assistant",
        content: ids.map((id) => ({ type: "tool-call", toolCallId: id, toolName: "bash", input: { command: "ls" } })),
    }) as ModelMessage;

const result = (id: string, value = "ok"): ModelMessage =>
    ({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value } }],
    }) as ModelMessage;

/** 健康历史：每个 call 都有 result */
const healthy = (): ModelMessage[] => [user("hi"), assistantCall("c1"), result("c1"), user("再跑一次")];

/** 坏历史（##444 的形状）：assistant 的 tool-call 没有对应 result */
const broken = (): ModelMessage[] => [user("hi"), assistantCall("lost-call"), user("继续")];

describe("scanToolResultPairs（体检，只读）", () => {
    it("健康历史 ⇒ missing 为空", () => {
        expect(scanToolResultPairs(healthy()).missing).toEqual([]);
    });

    it("缺 result ⇒ 报出 toolCallId / toolName / 所在消息下标", () => {
        const s = scanToolResultPairs(broken());
        expect(s.missing).toEqual([{ toolCallId: "lost-call", toolName: "bash", messageIndex: 1 }]);
    });

    it("一条 assistant 带多个 call、只到了一条 result ⇒ 只报缺的那条", () => {
        const s = scanToolResultPairs([user("hi"), assistantCall("a", "b"), result("a")]);
        expect(s.missing.map((m) => m.toolCallId)).toEqual(["b"]);
    });

    it("孤儿 result（有 result 没 call）⇒ 只报告不改（删消息的代价更难评估）", () => {
        const s = scanToolResultPairs([user("hi"), result("ghost")]);
        expect(s.orphanResults).toEqual(["ghost"]);
        expect(s.missing).toEqual([]);
    });
});

describe("ensureToolResultPairs（兜底）", () => {
    it("① 健康历史 ⇒ **返回同一数组引用**（幂等：prepareStep 每步都跑，靠它判「要不要覆盖」）", () => {
        const msgs = healthy();
        expect(ensureToolResultPairs(msgs)).toBe(msgs);
    });

    it("② 缺 result ⇒ 补一条占位（文案 = MISSING_TOOL_RESULT_NOTICE），配平可再检出为空", () => {
        const out = ensureToolResultPairs(broken());
        const s = scanToolResultPairs(out);
        expect(s.missing).toEqual([]);
        const toolMsgs = out.filter((m) => m.role === "tool");
        expect(toolMsgs).toHaveLength(1);
        expect(toolMsgs[0]!.content).toEqual([
            {
                type: "tool-result",
                toolCallId: "lost-call",
                toolName: "bash",
                output: { type: "text", value: MISSING_TOOL_RESULT_NOTICE },
            },
        ]);
    });

    it("③ 占位插在**该 assistant 之后连续的 tool 消息之后**（协议要求 result 紧跟 assistant）", () => {
        const keep = result("a");
        const out = ensureToolResultPairs([user("hi"), assistantCall("a", "b"), keep, user("继续")]);
        expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
        // 已有那条 result **同一引用**原样留着，占位补在它后面；别的消息也不重造（只做插入）
        expect(out[2]).toBe(keep);
        expect((out[3]!.content as { toolCallId: string }[])[0]!.toolCallId).toBe("b");
        expect((out[4] as { content: unknown }).content).toBe("继续");
    });

    it("④ 幂等：补过之后再跑 ⇒ 返回同一引用（不重复补）", () => {
        const once = ensureToolResultPairs(broken());
        expect(ensureToolResultPairs(once)).toBe(once);
    });

    it("⑤ 末尾缺 result（最后一条就是 assistant）⇒ 补在末尾", () => {
        const out = ensureToolResultPairs([user("hi"), assistantCall("tail")]);
        expect(out).toHaveLength(3);
        expect(out[2]!.role).toBe("tool");
    });

    it("⑥ 多个 assistant 各缺一条 ⇒ 各补各的，位置不串", () => {
        const out = ensureToolResultPairs([
            user("hi"),
            assistantCall("c1"),
            user("插话"),
            assistantCall("c2"),
        ]);
        const toolMsgs = out.filter((m) => m.role === "tool");
        expect(toolMsgs.map((m) => (m.content as { toolCallId: string }[])[0]!.toolCallId)).toEqual(["c1", "c2"]);
        expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
    });
});

// ── SDK 真跑（确定性判据）：不补就报错、补了就发得出去 ──
/**
 * 跑一次真实的 SDK 组装链，桩 fetch 接住定稿 body。
 *
 * ⚠️ 实测（本仓 ai 版本）：`AI_MissingToolResultsError` **不抛穿**，而是以流内 `error` part 报出
 * （`❌ [llm] Tool result is missing for tool call …` 就是那条 error 块，见 ##444 的现场日志）。
 * 所以判据是「有没有 error part」+「body 有没有发出去」，不是 try/catch。
 */
async function runSdk(
    messages: ModelMessage[],
): Promise<{ body: Record<string, unknown> | null; errorParts: { name?: string; message?: string }[] }> {
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
    const errorParts: { name?: string; message?: string }[] = [];
    try {
        const r = streamText({ model: provider("deepseek-v4.1-flash"), messages, maxRetries: 0 });
        for await (const part of r.fullStream) {
            if (part.type === "error") {
                const e = (part as unknown as { error?: { name?: string; message?: string } }).error;
                errorParts.push({ name: e?.name, message: e?.message });
            }
        }
    } catch {
        /* 真出现抛穿也是同一条结论：报错、没发出去 —— 由下面的断言覆盖 */
    }
    quiet.mockRestore();
    return { body: captured, errorParts };
}

describe("SDK 真跑（反证 ##445 的现场）", () => {
    it("不补 ⇒ AI_MissingToolResultsError 从流里报出，且请求**根本没发出去**（body 未捕获）", async () => {
        const { body, errorParts } = await runSdk(broken());
        expect(body).toBeNull();
        expect(errorParts.map((e) => e.name)).toEqual(["AI_MissingToolResultsError"]);
        expect(errorParts[0]!.message).toContain("Tool result is missing");
    });

    it("补了 ⇒ 无配对报错，且 wire 上有那条占位 result", async () => {
        const { body, errorParts } = await runSdk(ensureToolResultPairs(broken()));
        // 桩回 400 ⇒ 会有 AI_APICallError（那是桩的账）；关键是没有**配对**报错，且请求真发出去了
        expect(errorParts.map((e) => e.name)).not.toContain("AI_MissingToolResultsError");
        expect(body).not.toBeNull();
        const wire = (body as unknown as { messages: { role: string; content?: unknown }[] }).messages;
        const toolMsgs = wire.filter((m) => m.role === "tool");
        expect(toolMsgs).toHaveLength(1);
        expect(JSON.stringify(toolMsgs[0])).toContain(MISSING_TOOL_RESULT_NOTICE);
        expect(JSON.stringify(toolMsgs[0])).toContain("lost-call");
    });
});
