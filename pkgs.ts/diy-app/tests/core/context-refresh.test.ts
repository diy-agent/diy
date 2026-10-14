// tests/core/context-refresh.test.ts
// 🎯 ##310：**每步重算上下文**（prepareStep 及时刷新）
//
// 契约：同一轮内变量变了（例如 agent 自己 `diy task edit` 改了任务正文），**下一步**的请求
// 就要用新值，而不是等下一轮 —— 否则一次几小时的 tool 循环全程建在过期数据上。
// 手法同 local-agent-midturn-config：桩模型把「步边界」变成确定事件，断言口径 = 上游实际
// 收到的 prompt（`mock.doStreamCalls[i].prompt`）。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel, ModelMessage } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask, updateTask } from "../../src/main/core/task";
import { LocalAgentManager, replaceRuntimeInMessages } from "../../src/main/services/local-agent";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "ctx-refresh-work"));
});
let seq = 0;
const newUri = (title: string, body = ""): string => {
    const uri = createTask({ title: `${title} ${++seq}`, project: PROJECT });
    if (body) updateTask(uri, { body });
    return uri;
};

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};
function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
            },
        }),
    };
}
const textReply = (text: string) =>
    stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);
const toolCallReply = (callId: string, command: string) =>
    stream([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: callId, toolName: "bash" },
        { type: "tool-input-delta", id: callId, delta: JSON.stringify({ command }) },
        { type: "tool-input-end", id: callId },
        { type: "tool-call", toolCallId: callId, toolName: "bash", input: JSON.stringify({ command }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]);

/** 上游第 i 次请求的 prompt 全文（system + user + assistant 都算） */
function promptText(model: MockLanguageModelV3, callIndex: number): string {
    const prompt = model.doStreamCalls[callIndex]?.prompt ?? [];
    const out: string[] = [];
    for (const msg of prompt as Array<{ content: unknown }>) {
        const content = msg.content;
        if (typeof content === "string") out.push(content);
        else if (Array.isArray(content)) {
            for (const part of content as Array<{ text?: string }>) if (typeof part.text === "string") out.push(part.text);
        }
    }
    return out.join("\n");
}

describe("replaceRuntimeInMessages（纯函数）", () => {
    const msg = (content: string): ModelMessage => ({ role: "user", content });
    it("runtime 与输入合并成一条时，只替换 runtime 那一段", () => {
        const out = replaceRuntimeInMessages([msg("RT-旧\n用户的输入")], "RT-旧", "RT-新");
        expect((out![0] as { content: string }).content).toBe("RT-新\n用户的输入");
    });
    it("runtime 单独成条时整体替换", () => {
        const out = replaceRuntimeInMessages([msg("RT-旧")], "RT-旧", "RT-新");
        expect((out![0] as { content: string }).content).toBe("RT-新");
    });
    it("后面有 assistant/tool 时仍能找到并替换（不动其它消息）", () => {
        const msgs: ModelMessage[] = [msg("RT-旧\n输入"), { role: "assistant", content: "答复" }, msg("tool 结果")];
        const out = replaceRuntimeInMessages(msgs, "RT-旧", "RT-新")!;
        expect((out[0] as { content: string }).content).toBe("RT-新\n输入");
        expect(out[1]).toEqual({ role: "assistant", content: "答复" });
    });
    it("定位不到 / 旧值为空 → null（交给调用方兜底）", () => {
        expect(replaceRuntimeInMessages([msg("无关")], "RT-旧", "RT-新")).toBeNull();
        expect(replaceRuntimeInMessages([msg("任意")], "", "RT-新")).toBeNull();
    });
});

describe("轮内重算：变量变了 → 下一步请求即用新值", () => {
    it("轮内改任务正文（runtime）→ 第二步请求已含新正文", async () => {
        const uri = newUri("轮内改正文", "正文旧值-AAAAAAAAAA");
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                // 第一步发出后，模拟 agent 自己改掉了任务正文（tool 执行 `diy task edit` 的效果）
                if (call === 0) updateTask(uri, { body: "正文新值-BBBBBBBBBB" });
                const r = call === 0 ? toolCallReply("c1", "echo one") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
        // 第一步：旧值
        expect(promptText(model, 0)).toContain("正文旧值-AAAAAAAAAA");
        expect(promptText(model, 0)).not.toContain("正文新值-BBBBBBBBBB");
        // 第二步：新值（不必等下一轮）
        expect(promptText(model, 1)).toContain("正文新值-BBBBBBBBBB");
    });

    it("轮内改任务标题（system）→ 第二步请求的 system 已刷新", async () => {
        const uri = newUri("标题旧值-AAAAAAAAAA");
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                if (call === 0) updateTask(uri, { title: "标题新值-BBBBBBBBBB" });
                const r = call === 0 ? toolCallReply("c1", "echo two") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
        expect(promptText(model, 0)).toContain("标题旧值-AAAAAAAAAA");
        expect(promptText(model, 1)).toContain("标题新值-BBBBBBBBBB");
    });

    it("没变就不注入：第二步请求里不出现重复的 runtime 段", async () => {
        const uri = newUri("不变量", "正文固定值-CCCCCCCCCC");
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                const r = call === 0 ? toolCallReply("c1", "echo three") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        const count = (s: string, sub: string): number => s.split(sub).length - 1;
        // runtime 只出现一次（若每步都追加而非"变了才注入"，这里会 > 1）
        expect(count(promptText(model, 1), "正文固定值-CCCCCCCCCC")).toBe(1);
    });
});
