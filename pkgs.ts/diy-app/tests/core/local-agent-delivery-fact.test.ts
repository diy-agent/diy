// tests/core/local-agent-delivery-fact.test.ts
// 🎯 投递压缩可见性（##272 B1）：每轮**首步**的用量账带 `historySelection`
//   （= 配置驱动压缩的**事实**：预算 / 保留字节 / 保留段数 / 丢几条）。
// 与是否写了 compact 事件**无关** —— 投递本就每轮首按当前配置无条件重建；分表据此标注
// 「本步投递被压过」。这里钉住「轮首有、其余步没有」（只有轮首是配置驱动的重建点）。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { localDir, keyOf, sessionFile } from "../../src/main/core/local-paths";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { saveAutoCompact } from "../../src/main/core/auto-compact-config";
import type { StepUsageRecord } from "../../src/shared/usage";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_ZEN_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "delivery-fact-work"));
});

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function reply(): LanguageModelV3StreamResult {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "答复" },
        { type: "text-end", id: "t" },
        // 不手搓 start-step/finish-step：ai 由模型调用边界**合成**步（手搓会被内部转换层拒）
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
            },
        }),
    };
}

function seedOps(taskUri: string): void {
    const lines: string[] = [];
    for (let i = 1; i <= 3; i++) {
        const t = `t${8000 + i}`;
        lines.push(JSON.stringify({ op: "start", id: t, kind: "turn" }));
        lines.push(JSON.stringify({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } }));
        lines.push(JSON.stringify({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } }));
        lines.push(JSON.stringify({ op: "stop", id: `${t}_u` }));
        lines.push(JSON.stringify({ op: "stop", id: t }));
    }
    writeFileSync(opsFile(taskUri), lines.join("\n") + "\n", "utf-8");
}

describe("投递压缩可见性：每轮首步的用量账带 historySelection", () => {
    it("轮首步记录 historySelection（新口径 = token 上限）；其余步不带", async () => {
        const uri = createTask({ title: "投递事实", project: PROJECT });
        seedOps(uri);
        saveAutoCompact(diyHome(), {
            triggers: { systemContextChanged: true, cacheExpired: true, windowOverRatio: 0.5 },
            policy: { mode: "budget", modeData: { toolResult: { render: "asis" } }, summary: false },
        });
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub",
            doStream: () => Promise.resolve(reply()),
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "问一句")) void _op;

        const recs = readFileSync(sessionFile(uri, "usage"), "utf-8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as StepUsageRecord);
        expect(recs.length).toBeGreaterThanOrEqual(1);
        const s1 = recs.find((r) => r.step === 1)!;
        expect(s1.historySelection).toBeTruthy();
        // 报的是**唯一旋钮**的值（token 上限）；没有压缩边界 ⇒ 不丢消息
        expect(s1.historySelection!.retainTokens).toBe(30000);
        expect(s1.historySelection!.totalMessages).toBeGreaterThan(0);
        expect(s1.historySelection!.droppedMessages).toBe(0);
        // 只有轮首记（配置驱动的重建点）；其余步不带
        for (const o of recs.filter((r) => r.step !== 1)) expect(o.historySelection).toBeUndefined();
    });
});
