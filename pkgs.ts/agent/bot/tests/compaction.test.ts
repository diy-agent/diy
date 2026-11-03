// tests/compaction.test.ts — bot 上下文压缩（##517）
//
// 判据（来自 ##517 body）：
//   ① 塞满窗口 80% 的会话，下一轮自动触发
//   ② 压缩后能在消息流里看到 notice
//   ③ 压缩后对话能继续（模型记得大意 —— 摘要进了历史）
//   ④ 压缩失败时会话仍能继续（只是没压）
//   ⑤ 窗口未知 ⇒ 不压（不猜数）
//
// 算法（触发线 / 保留量 / 切点 / 摘要 prompt）一律来自 @diy-agent/compaction，本文件只验装配。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, LlmPort } from "@diy-agent/session";
import { createBotChat, createBotCompactor, type BotChatHost, type BotCompactionState, type WireMessage } from "../src/index.js";

/** 一条正文约 `chars` 个 CJK 字符（1 字 ≈ 1 token，估算口径见 compaction 包） */
const bodyOf = (chars: number): string => "历".repeat(chars);

const textOf = (messages: readonly WireMessage[]): string =>
    messages
        .map((message) => message.blocks.map((block) => (block.kind === "text" ? String(block.data["text"]) : "")).join(""))
        .join("\n");

/** 临时数据根：一个 custom provider，模型 `test/big` 的窗口可指定 */
function makeHome(contextLimit = 100_000): string {
    const home = mkdtempSync(join(tmpdir(), "bot-compaction-"));
    mkdirSync(join(home, "bots"), { recursive: true });
    writeFileSync(
        join(home, "model.yaml"),
        `customProviders:
  test:
    accounts:
      - type: apiKey
        name: main
        data:
          value: fake-key
`,
        "utf-8",
    );
    writeFileSync(
        join(home, "providers.custom.yaml"),
        `test:
  id: test
  npm: "@ai-sdk/openai-compatible"
  api: http://127.0.0.1:1/v1
  models:
    big:
      name: Big
      limit: { context: ${contextLimit} }
`,
        "utf-8",
    );
    return home;
}

/** 摘要请求的判据（与 compaction 包的 prompt 头一句对齐） */
const isSummaryRequest = (messages: readonly ChatMessage[]): boolean =>
    messages.some((message) => (message.text ?? "").includes("你是会话压缩助手"));

const SUMMARY_JSON = JSON.stringify({
    conclusions: ["之前已经聊了很多轮"],
    changes: [],
    todos: ["继续对话"],
    open: [],
});

/**
 * 假 LLM：正常对话回一段长正文；摘要请求回结构化 JSON。
 * `usage.inputTokens` 按历史条数增长 —— 模拟「这一步实际撑开了多大上下文」。
 */
const fakeLlm: LlmPort = {
    async *chat(messages) {
        if (isSummaryRequest(messages)) {
            yield { type: "text", text: SUMMARY_JSON };
            yield { type: "usage", inputTokens: 2000, outputTokens: 100 };
            yield { type: "done", stopReason: "stop" };
            return;
        }
        const last = [...messages].reverse().find((message) => message.role === "user");
        yield { type: "text", text: `收到：${(last?.text ?? "").slice(0, 20)}` };
        yield { type: "usage", inputTokens: 3000 * messages.length, outputTokens: 600 };
        yield { type: "done", stopReason: "stop" };
    },
};

/** 摘要调用必炸的 LLM（判据 4：压缩失败不阻断对话） */
const brokenSummaryLlm: LlmPort = {
    async *chat(messages) {
        if (isSummaryRequest(messages)) throw new Error("摘要服务 500");
        const last = [...messages].reverse().find((message) => message.role === "user");
        yield { type: "text", text: `收到：${(last?.text ?? "").slice(0, 20)}` };
        yield { type: "usage", inputTokens: 3000 * messages.length, outputTokens: 600 };
        yield { type: "done", stopReason: "stop" };
    },
};

const hostWith = (home: string, llm: LlmPort): BotChatHost => createBotChat({ home, llmFor: () => llm });

describe("bot 上下文压缩（##517）", () => {
    it("判据 ①②③：撑到 80% 窗口后下一轮自动压，消息流里有 notice，之后对话继续", async () => {
        const home = makeHome(100_000);
        const chat = hostWith(home, fakeLlm);
        await chat.createFirstBot({ model: "test/big" });

        // 每轮 user 800 字（估算 ≈ 800 token）+ 上一步实测按条数涨；约 15 轮后跨过触发线 84k
        let snapshot = await chat.snapshot();
        let compactedAt = -1;
        for (let i = 0; i < 30; i++) {
            snapshot = await chat.send(`第 ${i} 轮：${bodyOf(800)}`, () => {});
            if (compactedAt < 0 && textOf(snapshot.messages).includes("上下文已压缩")) compactedAt = i;
        }

        // ① 自动触发过
        expect(compactedAt).toBeGreaterThan(0);
        // ② 有痕（notice 在消息流里，且不是被静默丢弃）
        const rendered = textOf(snapshot.messages);
        expect(rendered).toContain("上下文已压缩");
        expect(rendered).toContain("丢弃 ");
        // 压完就不会拿着旧读数继续压（30 轮里最多两次 —— 保留段还远没到触发线）
        expect(rendered.split("上下文已压缩").length - 1).toBeLessThanOrEqual(2);
        // ③ 摘要进了历史（早前消息真的被换掉了）+ 压缩后对话能继续
        expect(rendered).toContain("<summary turns=");
        expect(rendered).not.toContain("第 0 轮");
        snapshot = await chat.send("压缩之后再问一句", () => {});
        expect(textOf(snapshot.messages)).toContain("收到：压缩之后再问一句");
        // 落盘：cutSeq 有值，重启后同一套切分还能重放
        const sessionId = JSON.parse(readFileSync(join(home, "bots", "bot-1", "bot.json"), "utf-8")) as {
            primarySessionId: string;
        };
        const stateFile = join(home, "sessions", "chat", sessionId.primarySessionId, "compaction.json");
        expect(existsSync(stateFile)).toBe(true);
        const state = JSON.parse(readFileSync(stateFile, "utf-8")) as BotCompactionState;
        expect(state.cutSeq).toBeGreaterThan(0);
        expect(state.summary.conclusions).toEqual(["之前已经聊了很多轮"]);

        // 重启后还是同一条会话，且压缩过的历史不会再被恢复成全量
        const again = await hostWith(home, fakeLlm).snapshot();
        expect(textOf(again.messages)).not.toContain("第 0 轮");
        expect(textOf(again.messages)).toContain("<summary turns=");
    });

    it("判据 ④：摘要调用失败 ⇒ 会话照常继续 + 留一条失败痕迹（不静默）", async () => {
        const home = makeHome(100_000);
        const chat = hostWith(home, brokenSummaryLlm);
        await chat.createFirstBot({ model: "test/big" });

        let snapshot = await chat.snapshot();
        let failedAt = -1;
        for (let i = 0; i < 30; i++) {
            snapshot = await chat.send(`第 ${i} 轮：${bodyOf(800)}`, () => {});
            if (failedAt < 0 && textOf(snapshot.messages).includes("上下文压缩失败")) failedAt = i;
        }
        expect(failedAt).toBeGreaterThan(0);
        // 对话没被挡住：失败之后还能接着问，并且得到回复
        snapshot = await chat.send("压缩失败之后还能聊吗", () => {});
        expect(textOf(snapshot.messages)).toContain("收到：压缩失败之后还能聊吗");
        // 失败不落压缩状态（下一轮再试）
        const sessionId = JSON.parse(readFileSync(join(home, "bots", "bot-1", "bot.json"), "utf-8")) as {
            primarySessionId: string;
        };
        expect(existsSync(join(home, "sessions", "chat", sessionId.primarySessionId, "compaction.json"))).toBe(false);
    });

    it("判据 ⑤：窗口未知 ⇒ 永不压缩（不猜数）", async () => {
        const home = makeHome(100_000);
        const chat = hostWith(home, fakeLlm);
        await chat.createFirstBot({ model: "test/big" });

        const saved: BotCompactionState[] = [];
        const compactor = createBotCompactor({
            windowTokens: null,
            llm: fakeLlm,
            loadState: async () => null,
            saveState: async (state) => {
                saved.push(state);
            },
        });
        compactor.noteStepTokens(999_999);
        const history: ChatMessage[] = [
            { seq: 1, role: "user", type: "human", text: bodyOf(1000) },
            { seq: 2, role: "assistant", type: "agent-conclusion", text: bodyOf(1000) },
        ];
        expect(await compactor.compact(history)).toEqual(history);
        expect(saved).toHaveLength(0);
    });
});
