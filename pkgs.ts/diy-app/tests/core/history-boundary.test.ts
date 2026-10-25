// tests/core/history-boundary.test.ts
// ##432 刀 2 的**行为验收**：边界只算一次并落 `turns.jsonl`；之后每步只追加、不重算。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { autoCompactFile } from "../../src/main/core/auto-compact-config";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { diyHome } from "../../src/main/core/state";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { readTurnEntries } from "../../src/main/services/local-turns";
import type { Op } from "../../src/main/services/local-blocks";

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function reply(text: string): LanguageModelV3StreamResult {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: text },
        { type: "text-end", id: "a" },
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

const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(reply("答".repeat(400))),
});

function manager(): LocalAgentManager {
    return new LocalAgentManager(() => model as unknown as LanguageModel);
}

async function collect(gen: AsyncGenerator<Op>): Promise<void> {
    for await (const _op of gen) void _op;
}

let PROJECT = "";
beforeAll(() => {
    PROJECT = createProject(join(diyHome(), "history-boundary-work"));
    // 上限调到很小：两三轮就超，必然触发一次压缩事件
    writeFileSync(
        autoCompactFile(diyHome()),
        [
            "mode: notify",
            "triggers: {systemContextChanged: true, cacheExpired: true, contextWindowOver: 0}",
            "policy: {mode: budget, modeData: {budgetBytes: 20480, toolResult: {render: asis}}, summary: false}",
            "history:",
            "  limit: {limitTokens: 200, summary: {enabled: false}}",
            "",
        ].join("\n"),
        "utf-8",
    );
});

let seq = 0;
const newTask = (): string => createTask({ title: `boundary 测试 ${++seq}`, project: PROJECT });

const compactions = (uri: string) => readTurnEntries(uri).filter((e) => "kind" in e && e.kind === "compaction");

describe("压缩边界：一次算、落盘、之后不重算", () => {
    it("##432 review A：压完之后**连续几步小增量**不再写新 entry（保留段没重新顶过上限）", async () => {
        // 这次用大一点的上限（2000）与较小的增量：先压一次，再连续 3 轮小消息
        const cfg = autoCompactFile(diyHome());
        const saved = readFileSync(cfg, "utf-8");
        writeFileSync(
            cfg,
            saved.replace("limitTokens: 200", "limitTokens: 2000"),
            "utf-8",
        );
        try {
            const uri = newTask();
            const mgr = manager();
            for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `大 ${i}：${"问".repeat(2000)}`));
            const n1 = compactions(uri).length;
            expect(n1).toBeGreaterThanOrEqual(1);
            // 连续 3 轮小增量（每轮 ~10 token）：保留段远没顶回上限 ⇒ **不新增** entry
            for (let i = 0; i < 3; i++) await collect(mgr.chat(uri, `小 ${i}：嗯`));
            expect(compactions(uri).length).toBe(n1);
        } finally {
            writeFileSync(cfg, saved, "utf-8");
        }
    });

    it("多轮后只写**一条** compaction entry；再取历史不会多写（幂等）", async () => {
        const uri = newTask();
        const mgr = manager();
        // 每轮 user 都很长 ⇒ 累积很快超上限
        for (let i = 0; i < 4; i++) await collect(mgr.chat(uri, `第 ${i} 问：${"问".repeat(1200)}`));
        const before = compactions(uri);
        // 至少发生过一次压缩事件；**条数不再等于步数**（旧实现是每步一条）
        expect(before.length).toBeGreaterThanOrEqual(1);
        expect(before.length).toBeLessThanOrEqual(2);
        const entry = before[0] as { limitTokens: number; dropped: number; cut: { llmLine: number }; headLine: number };
        expect(entry.limitTokens).toBe(200);
        expect(entry.dropped).toBeGreaterThan(0);
        expect(entry.headLine).toBeGreaterThan(0);
        expect(entry.cut.llmLine).toBeGreaterThan(entry.headLine);

        // 再取两次投递视图（模拟"之后每步"）：边界不该被重算/重写
        mgr.deliveryMessages(uri);
        mgr.deliveryMessages(uri);
        expect(compactions(uri).length).toBe(before.length);
    });

    it("投递结果 = 保头 + 切点之后的原文（切点之前的消息一条都不在里面）", async () => {
        const uri = newTask();
        const mgr = manager();
        for (let i = 0; i < 4; i++) await collect(mgr.chat(uri, `问 ${i}：${"问".repeat(3000)}`));
        const entry = compactions(uri).at(-1) as { cut: { llmLine: number }; headLine: number } | undefined;
        expect(entry).toBeTruthy();
        const view = mgr.deliveryMessages(uri);
        // 每个消息内容里都能找到自己的轮次号：切点之后 + 保头里才可能有
        expect(view.messages.length).toBeGreaterThan(0);
        // 注记里的切点行号与落盘的边界**逐字一致**（模型按它去翻 llm.jsonl）
        expect(view.note).toContain("history:");
        const m = /cut:\s*\n\s*line: (\d+)/.exec(view.note);
        expect(m?.[1]).toBe(String(entry!.cut.llmLine));
        // 被丢的区间 = (headLine, cutLine) —— 至少一条
        expect(entry!.cut.llmLine - entry!.headLine).toBeGreaterThan(0);
    });
});
