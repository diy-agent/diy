// tests/core/local-agent-ops-atomic.test.ts
// 🎯 两条契约，都是"残留开口块"这个坑的另一面：
//
// ① **结构性 op 批必须整批先落盘**：消费端断开时生成器以 return 展开，**只执行到 yield 就停**
//    （见 local-agent 的 closeTurn 头注）。一个块的 start/delta/stop 若逐条 yield，断开能正好
//    切在中间 → 盘上留个开口块，块里的文案（如「生成已取消」）永久丢失，只剩一个永远转圈的块。
//    实测来源：生产任务 262 的 error 块 start 落了、delta/stop 丢了。
//
// ② **残留收敛不只在加载时做，开新一轮时也要做**：自愈原先只挂 getSession（每个主进程一次），
//    于是"上一轮没闭合"（进程被杀 / 消费端把生成器整个丢下）能一直挂到主进程重启。
//    生产实测：开口 turn 跨越 9 轮、挂了 6 天。开新一轮时 sess.running 必为空（互斥守卫），
//    所以此刻"未 stop 的块"必然是残留 —— 补它是安全的。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import type { BlockStore, Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "ops-atomic-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `ops 原子性 ${++seq}`, project: PROJECT });

// ─── 桩模型 ────────────────────────────────────────────

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    }),
  };
}

/** 一段纯文本答复 */
const textReply = (text: string): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);

/** 先说一句、再吐一个 error part —— 后者的 handler 就是 errorBlock（start/delta/stop 三连） */
const errorReply = (text: string): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "error", error: new Error("上游炸了") },
  ]);

function stubModel(replies: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(replies[Math.min(call++, replies.length - 1)]!),
  });
}

/** 盘上的 op 行（链式 return 展开后 appendFileSync 已落盘，可同步读） */
function readOps(uri: string): Op[] {
  const fp = opsFile(uri);
  if (!existsSync(fp)) return [];
  return readFileSync(fp, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Op);
}

async function run(uri: string, message: string, model: MockLanguageModelV3, mgr?: LocalAgentManager): Promise<Op[]> {
  const m = mgr ?? new LocalAgentManager(() => model as unknown as LanguageModel);
  const ops: Op[] = [];
  for await (const op of m.chat(uri, message)) ops.push(op);
  return ops;
}

// ─── ① 结构性 op 批：原子落盘 ──────────────────────────

describe("结构性 op 批：断开切在中途也不许半截落盘", () => {
  it("error 块：消费到 start 就断开，delta/stop 必须也已在盘上（文案不许丢）", async () => {
    const uri = newUri();
    const model = stubModel([errorReply("先说一句")]);
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);

    const it = mgr.chat(uri, "会出错的一轮");
    let sawErrorStart = false;
    for (let i = 0; i < 100 && !sawErrorStart; i++) {
      const r = await it.next();
      if (r.done) break;
      if (r.value.op === "start" && r.value.kind === "error") sawErrorStart = true;
    }
    expect(sawErrorStart).toBe(true); // 桩流确实走到了 errorBlock
    // 消费端断开：http-server-binding 的 stream.on('close') → g.return() 做的事
    await it.return({ failed: false } as never);

    const ops = readOps(uri);
    const err = ops.find((o) => o.op === "start" && o.kind === "error");
    expect(err).toBeTruthy();
    const id = (err as { id: string }).id;
    expect(ops.some((o) => o.op === "delta" && (o as { id: string }).id === id)).toBe(true);
    expect(ops.some((o) => o.op === "stop" && (o as { id: string }).id === id)).toBe(true);
  });
});

// ─── ② 开新一轮时收敛残留（不等到重启） ─────────────────

describe("开新一轮时收敛残留：主进程活着也要补闭合", () => {
  it("内存 store 里的开口块，会被下一条消息开场补上 stop（内存 + 盘），且排在新 turn 之前", async () => {
    const uri = newUri();
    const model = stubModel([textReply("答复")]);
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);

    // 让会话对象先进内存（= 主进程活着），再注入一个"上一轮没闭合"的开口 turn 块 ——
    // 这正是「消费端把生成器整个丢下 / 进程被杀前那一瞬间」在内存与盘上的样子
    const sess = (
      mgr as unknown as { getSession(u: string): { store: BlockStore } }
    ).getSession(uri);
    sess.store.apply({ op: "start", id: "t9_stale", kind: "turn", meta: { model: "stale" } });
    expect(sess.store.blocks.get("t9_stale")?.stopped).toBe(false);

    await run(uri, "下一条消息", model, mgr);

    // ① 内存权威（store）里它已闭合 ② 盘上有它的 stop ③ stop 排在**新 turn 的 start 之前**
    expect(sess.store.blocks.get("t9_stale")?.stopped).toBe(true);
    const ops = readOps(uri);
    const stopAt = ops.findIndex((o) => o.op === "stop" && (o as { id: string }).id === "t9_stale");
    const newTurnAt = ops.findIndex((o) => o.op === "start" && o.kind === "turn" && (o as { id: string }).id !== "t9_stale");
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(newTurnAt).toBeGreaterThan(stopAt);

    // 幂等：再发一条消息不会重复补（补过一次就不再是"开口块"）
    await run(uri, "再一条", model, mgr);
    expect(readOps(uri).filter((o) => o.op === "stop" && (o as { id: string }).id === "t9_stale")).toHaveLength(1);
  });
});
