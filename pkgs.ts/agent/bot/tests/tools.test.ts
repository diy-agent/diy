// tests/tools.test.ts — bot 的工具循环（##514 第 3 步）
//
// 钉的是**两轮往返**这个最容易假绿的地方：
//   第一轮：模型点名 read → bot 执行 → 结果落成 role:'tool' 消息
//   第二轮：模型**看得到那条结果**（我们直接断言它收到的 messages）→ 基于结果回答
//
// 历史上一旦入向映射漏了（provider 的 toModelMessages 把 tool 消息丢掉），模型第二轮
// 看不见结果就会重复调同一个工具，直到步数上限 —— 表面上像「跑满 N 步」，实际是死循环。
// 所以这里除了「工具真跑了」，还要钉住「第二轮请求里带上了工具结果」。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTools } from "@diy-agent/tools";
import { openMemorySessionStore, type ChatMessage, type LlmPort, type SessionDelta } from "@diy-agent/session";
import { createBotChat, DEFAULT_MAX_TOOL_STEPS, type BotChatHost, type WireMessage } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "bot-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** home：只有模型目录，没有真 key（llmFor 注入脚本化假模型） */
function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "bot-tools-home-"));
    writeFileSync(
        join(home, "model.yaml"),
        `customProviders:\n  test:\n    accounts:\n      - type: apiKey\n        name: main\n        data:\n          value: fake-key\n`,
        "utf-8",
    );
    writeFileSync(
        join(home, "providers.custom.yaml"),
        `test:\n  id: test\n  npm: "@ai-sdk/openai-compatible"\n  api: http://127.0.0.1:1/v1\n  models:\n    echo-1:\n      name: Echo 1\n      cost: { input: 1, output: 2 }\n      limit: { context: 1000 }\n`,
        "utf-8",
    );
    return home;
}

/** 消息线 → 每条的纯文本（##499 起消息是 Block 列表） */
function textsOf(messages: readonly WireMessage[]): string[] {
    return messages.map((message) =>
        message.blocks
            .map((block) => (block.kind === "text" ? String(block.data["text"]) : `[${block.kind}]`))
            .join(""),
    );
}

/** 一轮要看的「模型收到了什么」 */
interface Seen {
    readonly calls: number;
    readonly toolMessages: readonly ChatMessage[];
}

/**
 * 脚本化模型：第 1 轮点 `read`，第 2 轮把工具结果当答案复述。
 * 同时记录每轮收到的 tool 消息 —— 入向映射漏了这里就会是空。
 */
function scriptedLlm(path: string, seen: { calls: number; toolMessages: ChatMessage[] }): LlmPort {
    return {
        async *chat(messages): AsyncIterable<SessionDelta> {
            seen.calls += 1;
            seen.toolMessages = messages.filter((message) => message.role === "tool");
            if (seen.calls === 1) {
                yield { type: "tool-call", id: "call_1", name: "read", input: JSON.stringify({ path }) };
                yield { type: "done", stopReason: "tool-calls" };
                return;
            }
            yield { type: "text", text: `文件里是：${seen.toolMessages.at(-1)?.text ?? "（没看到结果）"}` };
            yield { type: "usage", inputTokens: 10, outputTokens: 5 };
            yield { type: "done", stopReason: "stop" };
        },
    };
}

const seen = { calls: 0, toolMessages: [] as ChatMessage[] };

function host(home: string, tools = buildTools({ cwd: dir })): BotChatHost {
    return createBotChat({ home, llmFor: () => scriptedLlm("a.txt", seen), tools });
}

describe("bot 工具循环（##514 第 3 步）", () => {
    it("两轮往返：模型点工具 → bot 执行 → 第二轮模型看得到结果并据此回答", async () => {
        writeFileSync(join(dir, "a.txt"), "hello-514\n", "utf-8");
        const home = makeHome();
        const chat = host(home);
        await chat.createFirstBot({ model: "test/echo-1" });

        const snapshot = await chat.send("读一下 a.txt", () => {});

        // ① 模型真被调了两次（一次点工具、一次基于结果回答）
        expect(seen.calls).toBe(2);
        // ② 第二轮请求里带着工具结果（入向映射没漏）——这是死循环的判据
        expect(seen.toolMessages).toHaveLength(1);
        expect(seen.toolMessages[0]!.text).toContain("hello-514");
        // ③ 最终答复基于工具结果，而不是重复调工具
        const texts = textsOf(snapshot.messages);
        expect(texts.at(-1)).toContain("hello-514");
        expect(texts.at(-1)).toContain("文件里是");
        // ④ 消息线里 tool-call 与 tool-result 都在（UI 才有进度可画）
        expect(texts).toEqual(expect.arrayContaining(["[tool]"]));
    });

    it("工具不存在 ⇒ 失败结果回给模型（不抛、不死循环）", async () => {
        const home = makeHome();
        const calls = { count: 0 };
        const llm: LlmPort = {
            async *chat(): AsyncIterable<SessionDelta> {
                calls.count += 1;
                if (calls.count === 1) {
                    yield { type: "tool-call", id: "c1", name: "nope", input: "{}" };
                    yield { type: "done", stopReason: "tool-calls" };
                    return;
                }
                yield { type: "text", text: "好，没有这个工具" };
                yield { type: "done", stopReason: "stop" };
            },
        };
        const chat = createBotChat({ home, llmFor: () => llm, tools: buildTools({ cwd: dir }) });
        await chat.createFirstBot({ model: "test/echo-1" });
        const snapshot = await chat.send("用不存在的工具", () => {});
        expect(calls.count).toBe(2);
        expect(textsOf(snapshot.messages).at(-1)).toContain("没有这个工具");
    });

    it("步数上限：超限不报错，剩余调用标「未执行」并留 notice（历史保持合法）", async () => {
        const home = makeHome();
        let calls = 0;
        // 永远点工具：没有上限时这会死循环
        const llm: LlmPort = {
            async *chat(): AsyncIterable<SessionDelta> {
                calls += 1;
                yield { type: "tool-call", id: `c${calls}`, name: "read", input: JSON.stringify({ path: "a.txt" }) };
                yield { type: "done", stopReason: "tool-calls" };
            },
        };
        const chat = createBotChat({ home, llmFor: () => llm, tools: buildTools({ cwd: dir }), maxToolSteps: 2 });
        await chat.createFirstBot({ model: "test/echo-1" });
        const snapshot = await chat.send("一直调工具", () => {});

        // 2 步工具 ⇒ 4 次模型调用（第 3、4 次都会点工具：第 4 次收到「未执行」后我们不再执行也不再来一轮）
        // —— 关键是**有界**：上限到了就停，不会跑到天荒地老
        expect(calls).toBe(4);
        const texts = textsOf(snapshot.messages);
        // notice 说清了为什么停
        expect(texts.join("\n")).toContain(`工具循环已达上限（2 步）`);
        // 悬空的 tool-call 都有对应结果（否则下一轮请求不合法）
        const toolResults = snapshot.messages.filter((message) =>
            message.blocks.some((block) => block.kind === "tool" && block.data["state"] === "ok"),
        );
        expect(toolResults.length).toBeGreaterThanOrEqual(3);
        expect(DEFAULT_MAX_TOOL_STEPS).toBe(20);
    });

    it("不装工具 ⇒ 模型要求调工具时回「未执行」而不是静默跳过", async () => {
        const home = makeHome();
        const llm: LlmPort = {
            async *chat(): AsyncIterable<SessionDelta> {
                yield { type: "tool-call", id: "c1", name: "read", input: "{}" };
                yield { type: "done", stopReason: "tool-calls" };
            },
        };
        const chat = createBotChat({ home, llmFor: () => llm });
        await chat.createFirstBot({ model: "test/echo-1" });
        const snapshot = await chat.send("调工具", () => {});
        expect(textsOf(snapshot.messages).join("\n")).toContain("没有装工具");
    });
});
