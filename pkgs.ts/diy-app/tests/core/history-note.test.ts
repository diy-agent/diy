// tests/core/history-note.test.ts
// 🎯 ##421：压缩索引注记（`history:`）的四条判据
//
//   ① 未压缩（什么都没丢）⇒ **完全没有** `history:` 段（旧实现只看 policy 非空 ⇒ 恒注入）
//   ② 压缩 ⇒ 注记在 messages[1]（system 之后、历史第一条之前），**不在**尾部信封
//   ③ 注记不被 `normalizeUserRuns` 并进相邻 user 正文（紧随其后的那条 user 仍是原话）
//   ④ `keptBytes` 扣掉本轮 user 那一行（它作为 `user.message` 单独投递，不算历史字节）
//
// 口径：与真发同一条链 —— 桩模型记下 `doStreamCalls[i].prompt`，断言的就是**上游真实收到的形状**。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask, updateTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { utf8Bytes } from "../../src/shared/context/compaction";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "history-note-work"));
});
let seq = 0;
const newUri = (title: string): string => {
    const uri = createTask({ title: `${title} ${++seq}`, project: PROJECT });
    updateTask(uri, { body: "正文-AAAAAAAAAA" });
    return uri;
};

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const textReply = (text: string): LanguageModelV3StreamResult => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(c) {
            for (const p of [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: text },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] as LanguageModelV3StreamPart[]) {
                c.enqueue(p);
            }
            c.close();
        },
    }),
});

/**
 * 把历史预算写死（真源 = `$DIY_HOME/auto-compact.yaml`）。
 *
 * `history.keep` 只留 `ladder` 一级（**不放 `steps` 托底**）：托底级不耗预算、会把最近几条无条件留住，
 * 小会话里就永远压不到东西（本文件要的是「真丢掉一条」的现场）。
 */
const setBudget = (budgetBytes: number): void => {
    writeFileSync(
        join(diyHome(), "auto-compact.yaml"),
        JSON.stringify({
            mode: "notify",
            triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 38400 },
            policy: { mode: "budget", modeData: { budgetBytes, toolResult: { render: "asis" } }, summary: false },
            history: { keep: [{ type: "ladder" }] },
        }),
        "utf-8",
    );
};

type PromptMsg = { role: string; content: unknown };
const textOf = (c: unknown): string =>
    typeof c === "string" ? c : ((c ?? []) as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");

/**
 * 跑两轮纯文本对话，返回第 2 次请求的 prompt（= 上游真实收到的形状）。
 * `firstReply` 特意可调长：预算只够两条 user 时，它会被丢 —— 但「保留集里有旧 user」才有意义。
 */
async function twoTurns(budgetBytes: number, firstReply = "好"): Promise<PromptMsg[]> {
    setBudget(budgetBytes);
    const uri = newUri("注记判据");
    let call = 0;
    const model = new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: () => Promise.resolve(textReply(call++ === 0 ? firstReply : "好")),
    });
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
    for await (const _op of mgr.chat(uri, "第一轮")) void _op;
    for await (const _op of mgr.chat(uri, "第二轮")) void _op;
    return (model.doStreamCalls[1]?.prompt ?? []) as PromptMsg[];
}

/** 单条 user 消息的**投递**字节（与 `costOfWith` 同口径：`{role, content}` 的 JSON） */
const userBytes = (text: string): number => utf8Bytes(JSON.stringify({ role: "user", content: text }));

describe("##421 压缩注记：只在真丢弃时出现（判据 ①）", () => {
    it("预算撑满（什么都没丢）⇒ 全程没有 history: 段", async () => {
        const prompt = await twoTurns(1024 * 1024);
        // 没有任何一条消息是注记（注意：system 的 help 里本来就有 `history:` 子节，不能全文搜字符串）
        expect(prompt.every((m) => !textOf(m.content).startsWith("history:"))).toBe(true);
        // 历史完整：第一轮那条 user 还在
        expect(prompt.map((m) => textOf(m.content))).toContain("第一轮");
        // 历史末条仍是本轮输入（尾部信封照旧）
        expect(textOf(prompt[prompt.length - 1]!.content)).toContain("user:");
    });
});

describe("##421 压缩注记：位置与形态（判据 ②③）", () => {
    it("压缩 ⇒ 注记 = messages[1]（system 之后），尾部信封里没有它", async () => {
        const prompt = await twoTurns(64);
        expect(prompt[0]?.role).toBe("system");
        const note = textOf(prompt[1]?.content);
        expect(note.startsWith("history:")).toBe(true);
        expect(note).toContain("kept:");
        // 尾部只有 runtime + user
        const tail = textOf(prompt[prompt.length - 1]!.content);
        expect(tail).toContain("runtime:");
        // ⚠️ 判据 = 「行首是 history:」（顶层键），不是子串 —— runtime 变量树里存在
        // `where#history:` 这类**键名本身含 history:** 的单元（本任务实测踩到），子串判据必假红。
        expect(/^history:/m.test(tail)).toBe(false);
    });

    it("注记不被并进相邻 user 正文：紧随其后那条 user 仍是原话（不是「索引 + 原话」）", async () => {
        // 预算 = 两条 user 的字节和、且第一轮回复很长 ⇒ 旧 user 留下、长长的 assistant 被丢（真压缩）
        const prompt = await twoTurns(userBytes("第一轮") + userBytes("第二轮"), "好".repeat(300));
        expect(textOf(prompt[1]?.content).startsWith("history:")).toBe(true);
        // ③ 紧随注记的那条 user 仍是**纯粹的原话**（旧坑：被并成「history 索引 + 用户原话」一坨）
        expect(textOf(prompt[2]?.content)).toBe("第一轮");
    });
});

describe("##421 压缩注记：keptBytes 记账（判据 ④）", () => {
    it("kept 覆盖两行 user、keptBytes 只算历史那一条（扣掉本轮 user）", async () => {
        // 预算 = 两条 user 的字节和 ⇒ 两条 user 都保留、assistant 被丢（阶梯：user > text）
        const prompt = await twoTurns(userBytes("第一轮") + userBytes("第二轮"), "好".repeat(300));
        const note = textOf(prompt[1]?.content);
        expect(note.startsWith("history:")).toBe(true);
        // kept 里两行都在（1 = 第一轮，3 = 本轮输入）
        expect(note).toContain("- 1");
        expect(note).toContain("- 3");
        const keptBytes = Number(/keptBytes:\s*(\d+)/.exec(note)?.[1]);
        // ④ 只算第一轮那条：本轮 user 走 `user.message`，不进历史字节
        expect(keptBytes).toBe(userBytes("第一轮"));
    });
});
