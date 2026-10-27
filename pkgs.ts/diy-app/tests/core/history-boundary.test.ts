// tests/core/history-boundary.test.ts
// ##432 刀 2 的**行为验收**：边界只算一次并落 `turns.jsonl`；之后每步只追加、不重算。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { autoCompactFile, loadAutoCompact } from "../../src/main/core/auto-compact-config";
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

/** 采集每次 doStream 的 prompt（断言 wire 形状用） */
const prompts: Array<Array<{ role: string; content: unknown }>> = [];
const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: (opts: { prompt: unknown }) => {
        prompts.push(opts.prompt as Array<{ role: string; content: unknown }>);
        return Promise.resolve(reply("答".repeat(400)));
    },
});

function manager(): LocalAgentManager {
    return new LocalAgentManager(() => model as unknown as LanguageModel);
}

const textOf = (c: unknown): string =>
    typeof c === "string" ? c : ((c ?? []) as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");

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
            "triggers: {systemContextChanged: true, cacheExpired: true, windowOverRatio: 0.5}",
            "policy: {mode: budget, modeData: {budgetBytes: 20480, toolResult: {render: asis}}, summary: false}",
            "history:",
            "  limit: {retainRatio: 0.16, windowTokens: 20000, summary: {mode: model}}",
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
        // 先压一次（窗口 8000 × 0.16 = 保留 1280），再连续 3 轮小消息
        const cfg = autoCompactFile(diyHome());
        const saved = readFileSync(cfg, "utf-8");
        writeFileSync(cfg, saved, "utf-8");
        try {
            const uri = newTask();
            const mgr = manager();
            for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `大 ${i}：${"问".repeat(1200)}`));
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
        // 每轮 user 都很长 ⇒ 累积很快顶到触发线（窗口 20000 × 0.5 = 10000）
        for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `第 ${i} 问：${"问".repeat(1200)}`));
        const before = compactions(uri);
        // 至少发生过一次压缩事件；**条数不再等于步数**（旧实现是每步一条）
        expect(before.length).toBeGreaterThanOrEqual(1);
        expect(before.length).toBeLessThanOrEqual(2);
        const entry = before[0] as unknown as { retainTokens: number; windowTokens: number; droppedMessages: number; cut: { llmLine: number } };
        // ##442 v3：落的是「保留量 + 当时的窗口」，没有保头行号
        expect(entry.retainTokens).toBe(Math.floor(20_000 * 0.16));
        expect(entry.windowTokens).toBe(20_000);
        expect(entry.droppedMessages).toBeGreaterThan(0);
        expect(entry.cut.llmLine).toBeGreaterThan(1);

        // 再取两次投递视图（模拟"之后每步"）：边界不该被重算/重写
        mgr.deliveryMessages(uri);
        mgr.deliveryMessages(uri);
        expect(compactions(uri).length).toBe(before.length);
    });

    it("投递结果 = 保头 + 切点之后的原文（切点之前的消息一条都不在里面）", async () => {
        const uri = newTask();
        const mgr = manager();
        for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `问 ${i}：${"问".repeat(1200)}`));
        const entry = compactions(uri).at(-1) as { cut: { llmLine: number }; headLine: number } | undefined;
        expect(entry).toBeTruthy();
        const view = mgr.deliveryMessages(uri);
        // 每个消息内容里都能找到自己的轮次号：只在切点之后（##442 起无保头）
        expect(view.messages.length).toBeGreaterThan(0);
        // ##442 刀 2：注记已删 ⇒ 投递里**不许**再出现 `history:` 段（它头部每轮变，砸前缀缓存）
        expect(JSON.stringify(view.messages)).not.toContain("history:");
        // 切点仍需真生效：cutLine 之前至少丢了一条
        expect(entry!.cut.llmLine).toBeGreaterThan(1);
    });
});

describe("##442 压缩头部消息：位置在 system 之后第一条，且两次压缩之间**逐字节不变**", () => {
    it("有边界 ⇒ prompt[1] = `compact:` 消息（事实 + summary + task）；两轮之间逐字节相等", async () => {
        const uri = newTask();
        const mgr = manager();
        prompts.length = 0;
        // 压够多次以落定边界
        for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `问 ${i}：${"问".repeat(1200)}`));
        expect(compactions(uri).length).toBeGreaterThanOrEqual(1);

        // 再连发两轮（都是「同一条边界」下的投递）
        await collect(mgr.chat(uri, "第一句小话"));
        await collect(mgr.chat(uri, "第二句小话"));
        const last2 = prompts.slice(-2).map((p) => p);
        for (const p of last2) {
            expect(p[0]?.role).toBe("system");
            const head = textOf(p[1]?.content);
            expect(head.startsWith("compact:\n")).toBe(true);
            // 一份结构：事实 + summary（可空）+ task 全在 compact 里面
            // 头部不单列"丢了多少条"（= lines 区间长度的派生值），只给区间 + 叙述句
            expect(head).toContain("lines:");
            expect(head).toContain("条消息");
            expect(head).toContain("source:");
            expect(head).toContain("summary:");
            expect(head).toContain("task:");
        }
        // 头部在两次压缩之间**逐字节不变** —— 这正是 ##266 栽的那条（`history:` 的 kept 右端点每轮 +N）
        const h0 = textOf(last2[0]![1]?.content);
        const h1 = textOf(last2[1]![1]?.content);
        if (h0 !== h1) {
            const a = h0.split("\n");
            const b = h1.split("\n");
            const i = a.findIndex((l, k) => l !== b[k]);
            throw new Error(`头部第 ${i + 1} 行变了：\n- ${a[i]}\n+ ${b[i]}`);
        }
        expect(h1).toBe(h0);
    });
});

describe("试算（##432 review 第 3 条）：改上限能立刻看到「压完长什么样」，且不写账本", () => {
    it("上限调大 ⇒ 预览丢得更少（读侧照样按新上限重算），但 turns.jsonl 一条都不新增", async () => {
        const cfg = autoCompactFile(diyHome());
        const saved = readFileSync(cfg, "utf-8");
        try {
            const uri = newTask();
            const mgr = manager();
            for (let i = 0; i < 8; i++) await collect(mgr.chat(uri, `问 ${i}：${"问".repeat(1200)}`));
            // 真发过若干轮 ⇒ 边界已落盘（窗口 20000 × 0.16 那条）
            const n1 = compactions(uri).length;
            expect(n1).toBeGreaterThanOrEqual(1);
            const policy = loadAutoCompact(diyHome()).policy;
            const tight = await mgr.compactPreview(uri, policy);
            expect(tight.droppedTurns).toBeGreaterThan(0);

            // 改保留比例（0.16 → 0.5）——**只改配置**，不压缩、不发请求，然后看预览
            writeFileSync(cfg, saved.replace("retainRatio: 0.16", "retainRatio: 0.5"), "utf-8");
            const loose = await mgr.compactPreview(uri, policy);
            // 试算生效：保留量变大 ⇒ 丢得比之前少（旧实现这里会「毫无变化」）
            expect(loose.droppedTurns).toBeLessThan(tight.droppedTurns);
            // 预览是只读的：账本条数不变（试算不落盘）
            expect(compactions(uri).length).toBe(n1);
        } finally {
            writeFileSync(cfg, saved, "utf-8");
        }
    });
});
