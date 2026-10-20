// tests/core/room-self-context-inject.test.ts
// 🎯 房间上下文**真的进了发出去的那份请求**（##377 第 25/26 刀）—— 桩模型离线验证
//
// 单测 `room-self-context.test.ts` 验「算得对不对」；这里验的是**接线**，且判据取在
// **模型实际收到的 prompt** 上（不是我们自己的中间值）：runtime 段里有没有 `room.recent`。
//
//   · 自起一轮 ⇒ 尾部 runtime 信封里有房间近期发言（含别人的话，不含自己的）
//   · 下一轮（水位已前移）⇒ 那段不再出现（不重复）
//   · 投递来的（origin.room 指向**来源房间**）⇒ 看的是来源房间，正文仍是原话
//   · 没开过房间的任务 ⇒ runtime 里**没有 room 键**（单人任务运行时逐字不变）
//
// 反证的形状（第 26 刀的关键）：正文里**不许**再出现 `[本房间近期发言]` —— 那是被搬走的那条通道。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { advanceLastSeen, appendEvent, ensureRoom, upsertMember } from "../../src/main/core/room";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import type { Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "selfctx-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `轮首上下文 ${++seq}`, project: PROJECT });

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textReply(text: string): LanguageModelV3StreamResult {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
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

/** 桩模型：把**每次真发**的 prompt 原样记下来（判据要取在模型收到的那份上） */
function stubModel(sink?: { prompts: unknown[] }): LanguageModel {
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: (options) => {
      sink?.prompts.push(options.prompt);
      return Promise.resolve(textReply("收到"));
    },
  }) as unknown as LanguageModel;
}

/** prompt → 纯文本（content 可能是 string 或 text part 数组） */
function flatten(prompt: unknown): string {
  const msgs = Array.isArray(prompt) ? prompt : [];
  return msgs
    .map((m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return c;
      if (Array.isArray(c))
        return c.map((p) => (typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
      return "";
    })
    .join("\n");
}

/** 本轮**自己的那句原话**所在的消息（不是尾部 runtime 信封） */
function userBlock(prompt: unknown, text: string): string {
  const msgs = Array.isArray(prompt) ? prompt : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const one = flatten([msgs[i]]);
    if (one.includes(text)) return one;
  }
  return "";
}

async function run(
  uri: string,
  mgr: LocalAgentManager,
  origin?: Parameters<LocalAgentManager["chat"]>[6],
  prompts?: { prompts: unknown[] },
): Promise<{ ops: Op[]; prompt: string }> {
  const ops: Op[] = [];
  for await (const op of mgr.chat(uri, "跑一下测试", undefined, undefined, undefined, undefined, origin)) ops.push(op);
  const prompt = prompts?.prompts.at(-1);
  return { ops, prompt: flatten(prompt) };
}

const mkSay = (author: string, text: string, n: number) => ({
  id: `e${n}_seed`,
  ts: new Date(2026, 9, 20, 10, 0, n).toISOString(),
  channel: "default",
  kind: "say" as const,
  author,
  to: [],
  text,
  delivered: true,
});

/** 建一间「人 + 主人格」的房间，并灌一条别人的话 + 一条自己的话 */
function seedRoom(roomId: string, taskUri: string): void {
  ensureRoom(roomId);
  upsertMember(roomId, {
    id: "agent:main",
    name: "deepseek-4.1-flash",
    kind: "agent",
    backend: { type: "task", data: { taskUri } },
    main: true,
  });
  upsertMember(roomId, { id: "human:chen56", name: "chen56", kind: "human", backend: null });
  appendEvent(roomId, mkSay("human:chen56", "先跑一下测试", 1));
  appendEvent(roomId, mkSay("agent:main", "这句是我自己说的", 2));
}

describe("房间上下文真的进了请求（runtime 单元）", () => {
  it("① 自起一轮 ⇒ runtime 里有 room.recent（别人的话），正文仍是原话", async () => {
    const uri = newUri();
    seedRoom(uri, uri);
    const prompts = { prompts: [] as unknown[] };
    const { prompt, ops } = await run(uri, new LocalAgentManager(() => stubModel(prompts)), undefined, prompts);
    expect(prompt).toContain("runtime:");
    expect(prompt).toContain("room:");
    expect(prompt).toContain("先跑一下测试");
    // 不看自己：主人格自己说的那句不进 recent
    expect(prompt).not.toContain("这句是我自己说的");
    // 反证：正文里**不再**有那条被搬走的段
    const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")?.id ?? "";
    const mine = ops
      .filter((o) => o.op === "delta" && o.id === `${turnId}_u`)
      .map((o) => (o as { fields?: { content?: string } }).fields?.content ?? "")
      .join("");
    expect(mine).toBe("跑一下测试");
  });

  it("② 水位前移之后同一段不再出现（第二次请求里没有那段话）", async () => {
    const uri = newUri();
    seedRoom(uri, uri);
    const prompts = { prompts: [] as unknown[] };
    const mgr = new LocalAgentManager(() => stubModel(prompts));
    await run(uri, mgr, undefined, prompts);
    // 水位是异步写的（promise 链）—— 串到链尾再跑第二轮
    await advanceLastSeen(uri, {});
    const { prompt } = await run(uri, mgr, undefined, prompts);
    expect(prompt).not.toContain("先跑一下测试");
    // 成员单元仍在（低频、稳定）—— 别把"没有新发言"做成"没有房间"
    expect(prompt).toContain("room:");
  });

  it("③ 投递来的 ⇒ 看的是**来源房间**，正文仍是原话（不含房间前缀/近期发言）", async () => {
    const uri = newUri(); // 收件人自己的任务
    const src = `projects/${PROJECT}/tasks/9`;
    seedRoom(src, uri); // 来源房间里有个绑 uri 的成员
    const prompts = { prompts: [] as unknown[] };
    const { prompt, ops } = await run(
      uri,
      new LocalAgentManager(() => stubModel(prompts)),
      { author: "human:chen56", room: { roomId: src, sayId: "e_other" } },
      prompts,
    );
    expect(prompt).toContain("先跑一下测试"); // 来源房间的近期发言
    const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")?.id ?? "";
    const mine = ops
      .filter((o) => o.op === "delta" && o.id === `${turnId}_u`)
      .map((o) => (o as { fields?: { content?: string } }).fields?.content ?? "")
      .join("");
    expect(mine).toBe("跑一下测试");
  });

  it("④ 投递给**主人格**（`opsOriginFor` 整条不落 ⇒ 无 room）⇒ 退回本任务自己的房间", async () => {
    // 第 25 刀的回归（正文里两个 `[本房间近期发言]`）在新形状下不可能再发生：
    // 注入点只有一个（runtime），正文不再参与。这里钉住"仍拿得到上下文"。
    const uri = newUri();
    seedRoom(uri, uri);
    const prompts = { prompts: [] as unknown[] };
    const { prompt, ops } = await run(uri, new LocalAgentManager(() => stubModel(prompts)), { fromDelivery: true }, prompts);
    expect(prompt).toContain("先跑一下测试");
    const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")?.id ?? "";
    const mine = ops
      .filter((o) => o.op === "delta" && o.id === `${turnId}_u`)
      .map((o) => (o as { fields?: { content?: string } }).fields?.content ?? "")
      .join("");
    expect(mine).toBe("跑一下测试");
  });

  it("⑤ 没开过房间的任务 ⇒ runtime 里没有 room 键（单人任务运行时逐字不变）", async () => {
    const uri = newUri();
    const prompts = { prompts: [] as unknown[] };
    const { prompt, ops } = await run(uri, new LocalAgentManager(() => stubModel(prompts)), undefined, prompts);
    expect(prompt).not.toContain("room:");
    const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")?.id ?? "";
    const mine = ops
      .filter((o) => o.op === "delta" && o.id === `${turnId}_u`)
      .map((o) => (o as { fields?: { content?: string } }).fields?.content ?? "")
      .join("");
    expect(mine).toBe("跑一下测试");
  });
});
