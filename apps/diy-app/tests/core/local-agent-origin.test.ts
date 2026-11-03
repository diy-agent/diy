// tests/core/local-agent-origin.test.ts
// 🎯 投递来源真的落进 user 块（##377 第 23 刀）—— 桩模型离线验证
//
// 口径：`chat(..., origin)` 的 `author` / `room` 必须落进**轮首 user 块的 meta**，
// 且读侧（重放 ops）不许洗掉；不给 origin 时两个键都**不许出现**
// （`meta` 多一个空键就会让"逐字不变"的判据变味）。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { BlockStore, toTree, type Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "origin-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `投递来源 ${++seq}`, project: PROJECT });

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
  const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(textReply("收到")),
  });
  return model as unknown as LanguageModel;
}

/** 跑一轮，返回全部 op */
async function run(uri: string, mgr: LocalAgentManager, origin?: Parameters<LocalAgentManager["chat"]>[6]): Promise<Op[]> {
  const ops: Op[] = [];
  for await (const op of mgr.chat(uri, "一句话", undefined, undefined, undefined, undefined, origin)) ops.push(op);
  return ops;
}

/** 轮首 user 块（`<turnId>_u`）的 start.meta */
function userMeta(ops: Op[]): Record<string, unknown> | undefined {
  const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")?.id ?? "";
  const start = ops.find((o) => o.op === "start" && o.kind === "text" && o.id === `${turnId}_u`);
  return (start as { meta?: Record<string, unknown> } | undefined)?.meta;
}

describe("投递来源落进 user 块 meta", () => {
  it("给 origin ⇒ meta.author + meta.room 都在，room 逐字透传", async () => {
    const uri = newUri();
    const room = { roomId: "projects/1/tasks/9", sayId: "e1792423748105_12_ab3d" };
    const ops = await run(uri, new LocalAgentManager(() => stubModel()), { author: "human:chen56", room });
    const meta = userMeta(ops);
    expect(meta?.["role"]).toBe("user");
    expect(meta?.["author"]).toBe("human:chen56");
    expect(meta?.["room"]).toEqual(room);
  });

  it("读侧不洗：重放同一批 op，attrs.room 仍在", async () => {
    const uri = newUri();
    const room = { roomId: "projects/1/tasks/9", sayId: "e1" };
    const ops = await run(uri, new LocalAgentManager(() => stubModel()), { author: "agent:dev", room });
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const turnId = ops.find((o) => o.op === "start" && o.kind === "turn")!.id;
    // 读侧真值 = 块树（`toTree`，UI 用的同一份）—— 不是 op 流
    const node = toTree(store, turnId);
    type N = { id: string; attrs: Record<string, unknown>; children: N[] };
    const walk = (n: N): Record<string, unknown> | undefined => {
      if (n.id === `${turnId}_u`) return n.attrs;
      for (const c of n.children ?? []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return undefined;
    };
    const attrs = walk(node as unknown as N);
    expect(attrs?.["author"]).toBe("agent:dev");
    expect(attrs?.["room"]).toEqual(room);
  });

  it("不给 origin ⇒ meta 里**没有** author 也没有 room（逐字不变）", async () => {
    const uri = newUri();
    const ops = await run(uri, new LocalAgentManager(() => stubModel()));
    const meta = userMeta(ops);
    expect(meta?.["role"]).toBe("user");
    expect("author" in (meta ?? {})).toBe(false);
    expect("room" in (meta ?? {})).toBe(false);
  });
});
