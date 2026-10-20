// tests/core/room-self-context-inject.test.ts
// 🎯 轮首注入**真的进了 user 块**（##377 第 25 刀）—— 桩模型离线验证
//
// 单测 `room-self-context.test.ts` 验的是「算得对不对」；这里验的是**接线**：
//   · 自起一轮（不给 origin / seed）⇒ 轮首 user 块正文尾部带上「本房间近期发言」
//   · 下一轮（水位已前移）⇒ 不再带（不重复）
//   · 投递来的（origin.room 有值）⇒ **不再注入**（正文已由 `deliveryText` 带同一段，
//     再拼一遍就是同一段话进两次 —— 这是本刀最容易做错的一处）

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

function stubModel(): LanguageModel {
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(textReply("收到")),
  }) as unknown as LanguageModel;
}

async function run(
  uri: string,
  mgr: LocalAgentManager,
  origin?: Parameters<LocalAgentManager["chat"]>[6],
): Promise<Op[]> {
  const ops: Op[] = [];
  for await (const op of mgr.chat(uri, "跑一下测试", undefined, undefined, undefined, undefined, origin)) ops.push(op);
  return ops;
}

/** 轮首 user 块的正文（从 op 流里拼 delta） */
function userText(ops: Op[]): string {
  const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")?.id ?? "";
  const id = `${turnId}_u`;
  return ops
    .filter((o) => o.op === "delta" && o.id === id)
    .map((o) => (o as { fields?: { content?: string } }).fields?.content ?? "")
    .join("");
}

/** 建一间「人 + 主人格」的房间，并灌两条别人的话 */
function seedRoom(uri: string): void {
  ensureRoom(uri);
  upsertMember(uri, {
    id: "agent:main",
    name: "deepseek-4.1-flash",
    kind: "agent",
    backend: { type: "task", data: { taskUri: uri } },
    main: true,
  });
  upsertMember(uri, { id: "human:chen56", name: "chen56", kind: "human", backend: null });
  const mk = (author: string, text: string, n: number) => ({
    id: `e${n}_seed`,
    ts: new Date(2026, 9, 20, 10, 0, n).toISOString(),
    channel: "default",
    kind: "say" as const,
    author,
    to: [],
    text,
    delivered: true,
  });
  appendEvent(uri, mk("human:chen56", "先跑一下测试", 1));
  appendEvent(uri, mk("agent:main", "这句是我自己说的", 2));
}

describe("轮首注入真的进了 user 块", () => {
  it("① 自起一轮 ⇒ 正文尾部带「本房间近期发言」，且不含自己说的那句", async () => {
    const uri = newUri();
    seedRoom(uri);
    const ops = await run(uri, new LocalAgentManager(() => stubModel()));
    const text = userText(ops);
    expect(text.startsWith("跑一下测试")).toBe(true);
    expect(text).toContain("[本房间近期发言]");
    expect(text).toContain("chen56: 先跑一下测试");
    // 「不看自己」—— 主人格自己说的话不进段
    expect(text).not.toContain("这句是我自己说的");
  });

  it("② 水位前移之后同一段不再注入（下一轮正文逐字回到原话）", async () => {
    const uri = newUri();
    seedRoom(uri);
    const mgr = new LocalAgentManager(() => stubModel());
    await run(uri, mgr);
    // 水位是异步写的（promise 链）—— 串到链尾再跑第二轮（真实路径里两轮之间隔着一次模型请求）
    await advanceLastSeen(uri, {});
    const text = userText(await run(uri, mgr));
    expect(text).toBe("跑一下测试");
  });

  it("③ 投递来的（origin.room 有值）⇒ **不再注入**（正文已由 deliveryText 带同一段）", async () => {
    const uri = newUri();
    seedRoom(uri);
    const ops = await run(uri, new LocalAgentManager(() => stubModel()), {
      author: "human:chen56",
      room: { roomId: "projects/1/tasks/9", sayId: "e_other" },
    });
    const text = userText(ops);
    expect(text).toBe("跑一下测试");
    expect(text).not.toContain("[本房间近期发言]");
  });

  it("⑤ 投递给**主人格**（`opsOriginFor` 整条不落 ⇒ 无 room）仍算投递 ⇒ 不注入", async () => {
    // 实测抓出的回归（第 25 刀）：投给主人格 + 发起者是页面操作者本人时，`origin.room`
    // 按 §44.2 A 被掐掉，但正文**已经**由 `deliveryText` 带了房间上下文 ⇒ 只看 `room`
    // 会把同一段再拼一遍（lab 实测 user 正文里出现两个 `[本房间近期发言]`）。
    const uri = newUri();
    seedRoom(uri);
    const ops = await run(uri, new LocalAgentManager(() => stubModel()), { fromDelivery: true });
    const text = userText(ops);
    expect(text).toBe("跑一下测试");
    expect(text).not.toContain("[本房间近期发言]");
  });

  it("④ 没开过房间的任务 ⇒ 正文逐字不变（回归网：单人任务 / 老任务）", async () => {
    const uri = newUri();
    const ops = await run(uri, new LocalAgentManager(() => stubModel()));
    expect(userText(ops)).toBe("跑一下测试");
  });
});
