// scripts/ai-sdk-messages-demo.mts
// 🎯 研究范例：ai-sdk 的 streamText 历史消息（ModelMessage[]）到底该怎么给
//
// 运行：cd pkgs.ts/diy-app && npx tsx scripts/ai-sdk-messages-demo.mts
// 依赖环境变量：OPENCODE_ZEN_API_KEY（zen/go）
//
// 覆盖四个场景，实测 provider 的接受/拒绝行为：
//   A 正确配对（assistant.tool-call + role:tool 的 tool-result）→ 应通过
//   B 孤立 tool-call（只有 assistant 的 tool-call，没有 tool 结果）→ 应 400
//   C 带 reasoning 回传（deepseek thinking 模式）→ 应通过
//   D 同一历史去掉 reasoning → 观察是否 400（"reasoning_content must be passed back"）

import { streamText, tool, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const key = process.env["OPENCODE_ZEN_API_KEY"];
if (!key) throw new Error("缺少 OPENCODE_ZEN_API_KEY");

const provider = createOpenAICompatible({
    name: "zen-go",
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: key,
});

/** 与服务端 tools 定义保持一致（历史里的 tool-call 必须能在 tools 里找到同名工具） */
const tools = {
    bash: tool({
        description: "在项目目录执行 bash 命令并返回输出。",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => `(demo 不真执行) ${command}`,
    }),
};

async function run(label: string, model: string, messages: ModelMessage[]): Promise<void> {
    let inner: unknown = null; // streamText 内部失败会走 onError；只 await 结果拿到的可能是外层包装错误
    try {
        const result = streamText({
            model: provider(model),
            system: "你是测试助手，回答极简。",
            messages,
            tools,
            stopWhen: stepCountIs(3),
            maxOutputTokens: 200,
            maxRetries: 0, // 关闭重试，避免掩盖 400
            headers: { "x-opencode-session": "demo-session-1" },
            onError: ({ error }) => { inner = error; },
        });
        const text = await result.text; // ⚠️ 必须 await 结果，否则校验错误只会变成 unhandled rejection
        console.log(`${label}\n   ✅ OK → ${JSON.stringify(text.slice(0, 60))}\n`);
    } catch (e) {
        const e1 = inner ?? e;
        const name = e1 instanceof Error ? e1.constructor.name : typeof e1;
        const msg = e1 instanceof Error ? e1.message : String(e1);
        console.log(`${label}\n   ❌ ${name}: ${msg.slice(0, 200)}\n`);
    }
}

// ─── A：正确配对 ────────────────────────────────────────
const paired: ModelMessage[] = [
    { role: "user", content: "用 bash 跑一下 echo hi" },
    {
        role: "assistant",
        content: [
            { type: "text", text: "好，我跑一下。" },
            { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } },
        ],
    },
    {
        role: "tool",
        content: [
            {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "bash",
                output: { type: "text", value: "hi" },
            },
        ],
    },
    { role: "user", content: "输出是什么？一个字回答" },
];

// ─── B：孤立 tool-call（缺 tool 结果）────────────────────
const orphan: ModelMessage[] = [
    { role: "user", content: "用 bash 跑一下 echo hi" },
    {
        role: "assistant",
        content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } },
        ],
    },
    { role: "user", content: "继续" },
];

// ─── C / D：reasoning 回传 ──────────────────────────────
const withReasoning: ModelMessage[] = [
    { role: "user", content: "1+1 等于几？" },
    {
        role: "assistant",
        content: [
            { type: "reasoning", text: "用户问的是简单加法，我直接给出结果。" },
            { type: "text", text: "2" },
        ],
    },
    { role: "user", content: "那 2+2 呢？只回数字" },
];
const withoutReasoning: ModelMessage[] = [
    { role: "user", content: "1+1 等于几？" },
    { role: "assistant", content: [{ type: "text", text: "2" }] },
    { role: "user", content: "那 2+2 呢？只回数字" },
];

// ─── E：多步工具链（一个 turn 内两次工具调用）─────────
const multiStep: ModelMessage[] = [
    { role: "user", content: "先 echo a，再 echo b" },
    { role: "assistant", content: [
        { type: "reasoning", text: "先跑第一条命令。" },
        { type: "tool-call", toolCallId: "call_a", toolName: "bash", input: { command: "echo a" } },
    ] },
    { role: "tool", content: [
        { type: "tool-result", toolCallId: "call_a", toolName: "bash", output: { type: "text", value: "a" } },
    ] },
    { role: "assistant", content: [
        { type: "tool-call", toolCallId: "call_b", toolName: "bash", input: { command: "echo b" } },
    ] },
    { role: "tool", content: [
        { type: "tool-result", toolCallId: "call_b", toolName: "bash", output: { type: "text", value: "b" } },
    ] },
    { role: "user", content: "两条命令的输出分别是什么？一句话" },
];

// ─── F：工具失败的 output 类型 ─────────────────────────
const failedTool: ModelMessage[] = [
    { role: "user", content: "跑一下不存在的命令" },
    { role: "assistant", content: [
        { type: "tool-call", toolCallId: "call_x", toolName: "bash", input: { command: "nope" } },
    ] },
    { role: "tool", content: [
        { type: "tool-result", toolCallId: "call_x", toolName: "bash",
          output: { type: "error-text", value: "command not found: nope" } },
    ] },
    { role: "user", content: "刚才失败了吗？一个字" },
];

// ─── G：顺序错乱（tool 结果被放到 user 消息之后）─────────
const wrongOrder: ModelMessage[] = [
    { role: "user", content: "用 bash 跑一下 echo hi" },
    { role: "assistant", content: [
        { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } },
    ] },
    { role: "user", content: "顺便问一下，今天是周几？" },
    { role: "tool", content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "hi" } },
    ] },
];

console.log("═══ 历史消息规则实测（zen/go）═══\n");
await run("A 正确配对（tool-call + tool-result，glm-5.3-flash）", "glm-5.3-flash", paired);
await run("B 孤立 tool-call，无 tool-result（glm-5.3-flash）", "glm-5.3-flash", orphan);
await run("C 回传 reasoning（deepseek-v4-flash）", "deepseek-v4-flash", withReasoning);
await run("D 不回传 reasoning（deepseek-v4-flash）", "deepseek-v4-flash", withoutReasoning);
await run("E 多步工具链：2× (tool-call + tool-result)（glm-5.3-flash）", "glm-5.3-flash", multiStep);
await run("F 工具失败用 error-text 输出（glm-5.3-flash）", "glm-5.3-flash", failedTool);
await run("G 顺序错乱：tool-result 放到下一条 user 之后（glm-5.3-flash）", "glm-5.3-flash", wrongOrder);
