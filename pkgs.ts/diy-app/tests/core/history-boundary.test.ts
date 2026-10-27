// tests/core/history-boundary.test.ts
// ##442：边界只在压缩事件时算一次并落 turns.jsonl；手动压缩无限制（内容再小也至少丢一步）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { autoCompactFile, loadAutoCompact } from "../../src/main/core/auto-compact-config";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { diyHome } from "../../src/main/core/state";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { readTurnEntries, readTurnRecords } from "../../src/main/services/local-turns";
import type { Op } from "../../src/main/services/local-blocks";

let usageTotal = 5_000; // 让「最后一步实测用量」过触发线（窗口 20k → 触发线 4k）
const usage = (): LanguageModelV3Usage => ({
    inputTokens: { total: usageTotal, noCache: usageTotal, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
});

function reply(text: string): LanguageModelV3StreamResult {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: text },
        { type: "text-end", id: "a" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
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
    // 窗口 20k ⇒ 保留 3.2k、触发 4k（小会话也容易真丢）
    writeFileSync(
        autoCompactFile(diyHome()),
        [
            "policy: {mode: budget, modeData: {toolResult: {render: asis}}, summary: false}",
            "history:",
            "  limit: {windowTokens: 50000, summary: {mode: self}}",
            "",
        ].join("\n"),
        "utf-8",
    );
});

beforeEach(() => {
    usageTotal = 5_000;
});

let seq = 0;
const newTask = (): string => createTask({ title: `boundary 测试 ${++seq}`, project: PROJECT });
const compactions = (uri: string) => readTurnEntries(uri).filter((e) => "kind" in e && e.kind === "compaction");

/** 先低用量攒历史，再用一次高用量触发压缩（模拟真实：压完 usage 会掉） */
async function seedAuto(mgr: LocalAgentManager, uri: string, turns = 12): Promise<void> {
    usageTotal = 100;
    for (let i = 0; i < turns; i++) await collect(mgr.chat(uri, `大 ${i}：${"问".repeat(3000)}`));
    usageTotal = 35_000;
    await collect(mgr.chat(uri, "记一笔高用量"));
    usageTotal = 100;
    await collect(mgr.chat(uri, "触发"));
}

describe("压缩边界：一次算、落盘、之后不重算", () => {
    it("压完之后连续几步小增量不再写新 entry（保留段没重新顶到触发线）", async () => {
        const uri = newTask();
        const mgr = manager();
        await seedAuto(mgr, uri);
        const n1 = compactions(uri).length;
        expect(n1).toBeGreaterThanOrEqual(1);
        // 之后用量降到触发线以下：先跑一轮让账本记下低用量（这一轮可能还按上一轮的高用量压一次），
        // 再连跑三轮，都不该新增 entry。
        usageTotal = 100;
        await collect(mgr.chat(uri, "小 0：嗯"));
        const n2 = compactions(uri).length;
        for (let i = 1; i <= 3; i++) await collect(mgr.chat(uri, `小 ${i}：嗯`));
        expect(compactions(uri).length).toBe(n2);
    });

    it("多轮后 entry 带 v3 的 retainTokens / windowTokens；再取历史不会多写", async () => {
        const uri = newTask();
        const mgr = manager();
        await seedAuto(mgr, uri);
        const before = compactions(uri);
        expect(before.length).toBeGreaterThanOrEqual(1);
        const entry = before.at(-1) as {
            v: number;
            retainTokens?: number;
            windowTokens?: number;
            cut: { llmLine: number };
        };
        expect(entry.v).toBe(3);
        expect(entry.retainTokens).toBe(8_000);
        expect(entry.windowTokens).toBe(50_000);
        expect(entry.cut.llmLine).toBeGreaterThan(1);

        mgr.deliveryMessages(uri);
        mgr.deliveryMessages(uri);
        expect(compactions(uri).length).toBe(before.length);
    });

    it("投递 = 切点之后的原文；不再出现 history:", async () => {
        const uri = newTask();
        const mgr = manager();
        await seedAuto(mgr, uri);
        const entry = compactions(uri).at(-1) as { cut: { llmLine: number } } | undefined;
        expect(entry).toBeTruthy();
        const view = mgr.deliveryMessages(uri);
        expect(view.messages.length).toBeGreaterThan(0);
        expect(JSON.stringify(view.messages)).not.toContain("history:");
    });
});

describe("128k 窗口 + 24k fixed：到线必须真压（修 auto noop）", () => {
    it("history 只有约 90k（< 112k 触发线），但 total 到线 ⇒ 必须写边界", async () => {
        const uri = newTask();
        const mgr = manager();
        const cfg = autoCompactFile(diyHome());
        const saved = readFileSync(cfg, "utf-8");
        writeFileSync(
            cfg,
            [
                "policy: {mode: budget, modeData: {toolResult: {render: asis}}, summary: false}",
                "history:",
                "  limit: {windowTokens: 128000, summary: {mode: self}}",
                "",
            ].join("\n"),
            "utf-8",
        );
        try {
            // 先攒约 90k 历史；用量压到触发线以下，保证攒历史期间不自动压
            usageTotal = 100;
            for (let i = 0; i < 26; i++) await collect(mgr.chat(uri, `大 ${i}：${"问".repeat(3000)}`));
            expect(compactions(uri).length).toBe(0);
            // 写一条 total=114k 的用量（仍 < 128k 窗口，但 >= 112k 触发线）
            usageTotal = 114_000;
            await collect(mgr.chat(uri, "记一笔用量"));
            // 下一次 chat 的 autoCompactStatus 会读到 114k 并触发；history 只有约 90k
            await collect(mgr.chat(uri, "触发"));
            expect(compactions(uri).length).toBeGreaterThanOrEqual(1);
        } finally {
            writeFileSync(cfg, saved, "utf-8");
        }
    });
});

describe("preflight 超 0.8W：写边界，不是只 cap 这一轮（##442 step 6 P0-1）", () => {
    it("小窗口 + 大消息：preflight 触发后 turns 里有压缩边界", async () => {
        const uri = newTask();
        const mgr = manager();
        const cfg = autoCompactFile(diyHome());
        const saved = readFileSync(cfg, "utf-8");
        writeFileSync(
            cfg,
            [
                "policy: {mode: budget, modeData: {toolResult: {render: asis}}, summary: false}",
                "history:",
                "  limit: {windowTokens: 40000, summary: {mode: self}}",
                "",
            ].join("\n"),
            "utf-8",
        );
        try {
            usageTotal = 100; // 不让 auto 触发，只让 preflight 触发
            // 至少两轮才切得动；单条巨型 user 没有「更老的一段」可丢
            for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `大消息 ${i}：${"问".repeat(5000)}`));
            expect(compactions(uri).length).toBeGreaterThanOrEqual(1);
        } finally {
            writeFileSync(cfg, saved, "utf-8");
        }
    });
});

describe("手动压缩无限制（##442 用户 2026-10-27 选 C）", () => {
    it("小会话（总量远低于触发线）点压缩：仍写边界、至少丢一步", async () => {
        const uri = newTask();
        const mgr = manager();
        for (let i = 0; i < 3; i++) await collect(mgr.chat(uri, `小 ${i}：嗯`));
        expect(compactions(uri).length).toBe(0);
        const policy = loadAutoCompact(diyHome()).policy;
        const rec = mgr.compact(uri, policy, "ui", undefined, "manual", true);
        expect(rec.noop).not.toBe(true);
        const entries = compactions(uri);
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const cut = (entries.at(-1) as { cut: { llmLine: number } }).cut.llmLine;
        expect(cut).toBeGreaterThan(1);

        // 下一次请求：system 之后先 notify.compact（只有 source / summary），再是保留历史
        const view = await mgr.requestView(uri);
        const first = (view.messages[0] as { content?: string } | undefined)?.content ?? "";
        expect(first.startsWith("notify:\n")).toBe(true);
        expect(first).toContain("kind: compact");
        expect(first).toContain("source:");
        expect(first).toContain("summary:");
        expect(first).not.toContain("at:");
        expect(first).not.toContain("dropped");
    });

    it("undo：投递边界也回退（不是只回滚审计）", async () => {
        const uri = newTask();
        const mgr = manager();
        for (let i = 0; i < 3; i++) await collect(mgr.chat(uri, `小 ${i}：${"问".repeat(1200)}`));
        const policy = loadAutoCompact(diyHome()).policy;
        mgr.compact(uri, policy, "ui", undefined, "manual", true);
        const beforeUndo = JSON.stringify(mgr.deliveryMessages(uri).messages);
        const rec = mgr.compactEvents(uri).events.filter((e) => e.kind === "compact").at(-1);
        expect(rec).toBeTruthy();
        expect(mgr.undoCompact(uri, (rec as { id: string }).id)).toBe(true);
        const afterUndo = JSON.stringify(mgr.deliveryMessages(uri).messages);
        expect(afterUndo).not.toBe(beforeUndo);
        expect(afterUndo).toContain("小 0");
    });

    it("再点一次：切点继续前进（不会把历史放回来）", async () => {
        const uri = newTask();
        const mgr = manager();
        for (let i = 0; i < 5; i++) await collect(mgr.chat(uri, `小 ${i}：嗯`));
        const policy = loadAutoCompact(diyHome()).policy;
        mgr.compact(uri, policy, "ui", undefined, "manual", true);
        const first = (compactions(uri).at(-1) as { cut: { llmLine: number } }).cut.llmLine;
        mgr.compact(uri, policy, "ui", undefined, "manual", true);
        const second = (compactions(uri).at(-1) as { cut: { llmLine: number } }).cut.llmLine;
        expect(second).toBeGreaterThan(first);
    });
});
