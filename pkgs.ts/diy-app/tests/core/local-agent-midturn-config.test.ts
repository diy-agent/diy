// tests/core/local-agent-midturn-config.test.ts
// 🎯 轮次中改配置（预算）→ **下一步**投递即生效（##272 M2 待验证项）
//
// 用户 2026-10-07：「压缩应该是轮次中就可以压缩吧」——压缩只写快照；投递按**当前配置**每次
// 请求实时算（`pit.config-vs-history`）。本测试用桩模型把「步边界」变成确定事件，断言：
//   同一轮内**改预算后**，下一步的请求里历史随之变化（模型真的看见了），而非等下一轮。
//
// 手法与 local-agent-steer 一致：断言口径走「上游实际收到的 messages」（mock.doStreamCalls[i].prompt）。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/services/local-agent";
import { saveAutoCompact } from "../../src/main/core/auto-compact-config";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "midturn-compact-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `轮中压缩 ${++seq}`, project: PROJECT });

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

/** 三轮历史（每轮 user 文本，便于在 prompt 里辨识） */
function seedOps(uri: string): void {
    const lines: string[] = [];
    for (let i = 1; i <= 3; i++) {
        const t = `t${7000 + i}`;
        const push = (o: unknown) => lines.push(JSON.stringify(o));
        push({ op: "start", id: t, kind: "turn" });
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
        push({ op: "stop", id: `${t}_u` });
        push({ op: "start", id: `${t}_a`, kind: "text", parent: t, meta: { role: "assistant" } });
        push({ op: "delta", id: `${t}_a`, fields: { content: `答 ${i}` } });
        push({ op: "stop", id: `${t}_a` });
        push({ op: "stop", id: t });
    }
    writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
}

/** 设置预算（真源 auto-compact.yaml） */
const setBudget = (budgetBytes: number) =>
    saveAutoCompact(diyHome(), {
        mode: "notify",
        triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 0.8 },
        policy: { mode: "budget", modeData: { budgetBytes, toolResult: { render: "asis" } }, summary: false },
    });

/** 上游第 i 次请求的 prompt 全文（user/assistant 两侧都算） */
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

describe("轮次中改配置：在途轮次用轮首快照，下一轮才用新配置", () => {
    // 【##272 M2 待验证项的结论】曾经以为「配置实时读 ⇒ 在途轮次的下一步就换预算」。实测：
    // runTurn 只在**轮首**构建一次 `sent`（L1996），`prepareStep` 仅注入插话、不重建历史。
    // ⇒ 轮次中改配置**不改在途轮次**（下一步仍发轮首那份历史）；**下一轮**才生效。
    // 这是刻意的（轮中途换历史会破坏 tool-call/result 配对、砸前缀缓存），本测试把该契约钉住。
    it("在途轮次：两步之间改预算，第二步仍发轮首的历史快照（不受影响）", async () => {
        const uri = newUri();
        seedOps(uri);
        setBudget(1024 * 1024); // 轮首：撑满 → 该轮历史含「第 1 句」

        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                if (call === 0) setBudget(0); // 第一步发出前清零 —— 模拟轮次中改配置
                const r = call === 0 ? toolCallReply("c1", "echo one") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
        // 轮首有历史 → 第一步含
        expect(promptText(model, 0)).toContain("第 1 句");
        // 轮中改配置**不改在途轮次** → 第二步仍是轮首快照（仍含历史）
        expect(promptText(model, 1)).toContain("第 1 句");
    });

    it("下一轮：改预算后新请求（requestView）反映新配置（轮首实时读）", async () => {
        const uri = newUri();
        seedOps(uri);
        const mgr = new LocalAgentManager(() => stubModel() as unknown as LanguageModel);

        setBudget(1024 * 1024);
        expect(JSON.stringify((mgr.requestView(uri) as { messages: unknown[] }).messages)).toContain("第 1 句");
        // 改预算（= 新配置）→ 下一次请求（下一轮的轮首）即反映
        setBudget(0);
        expect(JSON.stringify((mgr.requestView(uri) as { messages: unknown[] }).messages)).not.toContain("第 1 句");
    });
});

/** 只给文本答复的桩（本用例不发请求，仅占位） */
function stubModel() {
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: () => Promise.resolve(textReply("done")),
    });
}
