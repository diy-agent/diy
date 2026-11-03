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
import { asToolSet, createBotChat, DEFAULT_MAX_TOOL_STEPS, type BotChatHost, type WireMessage } from "../src/index.js";

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
    return createBotChat({ home, llmFor: () => scriptedLlm("a.txt", seen), toolsFor: () => asToolSet(tools) });
}

describe("bot 工具循环（已交给 ai-sdk）", () => {
    // 原来三个用例测的是 bot 自己写的 runToolLoop（两轮往返 / 未知工具 / 步数上限）。
    // ##514 教训（用户 2026-11-04：「diy-agent 已经有很完善的 agent 对话核心，请参考撰写，
    // 不要重新发明」）：循环改由 ai-sdk 的 streamText({ tools, stopWhen: stepCountIs(n) }) 负责，
    // 那套行为在 provider 层测（tests/openai.test.ts 的「工具透传」）。
    // 留个占位说明位置，不留测不到东西的用例。
    it("循环在 ai-sdk 里；bot 只负责透传 tools（见 provider 测试）", () => {
        expect(true).toBe(true);
    });
});
