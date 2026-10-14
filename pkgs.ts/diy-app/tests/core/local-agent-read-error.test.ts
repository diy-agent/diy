// tests/core/local-agent-read-error.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##329：read 工具失败必须变成 **tool 块的 status:"error"**
//
// 现象：`read` 读不到文件时（ENOENT / offset 越界 / 二进制），行摘要与图标都显示**成功 ✓**，
// 失败文案只躺在折叠正文里 —— 模型看得见，用户看不见。
//
// 根因（数据侧，不是少画一个图标）：`read.execute` catch 掉异常并 **return 字符串**
//   ⇒ 返回值是正常工具结果 ⇒ AI SDK 走 `tool-result` 分支 ⇒ patch `status:"done"`
//   ⇒ UI 的 statusMark 按 status 画 ✓，且 `status=error` 的恒展开规则不触发。
// 只有 `tool-error` 分支才 `status:"error"`。
//
// 本文件锁的就是这条链路，且**必须端到端**（单测只能证明"抛了"）：
//   execute 抛 → SDK 发 tool-error → ops 落 patch status:"error"
// 桩模型的理由：真实 LLM 无法保证"这一步一定调 read、下一步一定给答复"，而断言的对象
// 恰好是这两步之间的 SDK 行为。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { BlockStore, blocksToMessages, type Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "read-error-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `read 失败 ${++seq}`, project: PROJECT });

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

/** 一段纯文本答复（含 finish，= 该段结束） */
const textReply = (text: string): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);

/** 一次 read 工具调用（会让 SDK 继续下一步，除非步数用尽） */
const readCallReply = (callId: string, path: string): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: callId, toolName: "read" },
    { type: "tool-input-delta", id: callId, delta: JSON.stringify({ path }) },
    { type: "tool-input-end", id: callId },
    { type: "tool-call", toolCallId: callId, toolName: "read", input: JSON.stringify({ path }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ]);

/** 造一个按序吐流的桩模型；越界复用最末一条 */
function stubModel(replies: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(replies[Math.min(call++, replies.length - 1)]!),
  });
}

/**
 * 上游第 i 次请求的**整份 prompt 序列化**（判断"模型看见没看见"）。
 *
 * 为什么整份序列化而不是只抓 `text` 字段：tool 结果不在 `text` 上 ——
 * tool-result part 的载荷在 `output`（V3 形状随 SDK 版本变），只抓 text 会把
 * 「工具结果确实回灌了」误判成「没回灌」。这里只关心"这句话在不在请求里"，
 * 形状细节交给 SDK 自己演进。
 */
function promptDump(model: MockLanguageModelV3, callIndex: number): string {
  return JSON.stringify(model.doStreamCalls[callIndex]?.prompt ?? []);
}

async function run(uri: string, model: MockLanguageModelV3): Promise<Op[]> {
  const ops: Op[] = [];
  const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
  for await (const op of mgr.chat(uri, "读个不存在的文件")) ops.push(op);
  return ops;
}

/** 某个 tool 块的终态 status（最后一次 patch 为准） */
function statusOf(ops: Op[], id: string): string | undefined {
  let last: string | undefined;
  for (const op of ops) {
    if (op.op !== "patch" || op.id !== id) continue;
    const s = (op.fields as { status?: unknown }).status;
    if (typeof s === "string") last = s;
  }
  return last;
}

/** 某个 tool 块的 output 正文 */
function outputOf(ops: Op[], id: string): string {
  return ops
    .filter((op): op is Extract<Op, { op: "delta" }> => op.op === "delta" && op.id === id)
    .map((op) => (op.fields as { output?: unknown }).output)
    .filter((v): v is string => typeof v === "string")
    .join("");
}

const toolIds = (ops: Op[]): string[] =>
  ops.filter((o) => o.op === "start" && o.kind === "tool").map((o) => (o as { id: string }).id);

describe("read 失败 → tool 块 status:error（##329）", () => {
  it("文件不存在：终态是 error（不是 done），文案仍在 output 里", async () => {
    const uri = newUri();
    const model = stubModel([
      readCallReply("c1", "/nonexistent-diy-329/nope.txt"),
      textReply("读不到，换个路径"),
    ]);

    const ops = await run(uri, model);

    const id = toolIds(ops)[0];
    expect(id).toBeTruthy();
    expect(statusOf(ops, id!)).toBe("error");
    expect(outputOf(ops, id!)).toContain("[读取失败]");
    // 不能同时又落一条 done —— UI 取最后一次 patch，两条并存说明分支串了
    expect(
      ops.filter((o) => o.op === "patch" && o.id === id && (o.fields as { status?: string }).status === "done"),
    ).toHaveLength(0);
  });

  it("模型侧不受影响：失败文案照旧随 tool 结果回灌给下一步", async () => {
    const uri = newUri();
    const model = stubModel([
      readCallReply("c1", "/nonexistent-diy-329/nope.txt"),
      textReply("读不到，换个路径"),
    ]);

    await run(uri, model);

    // 旧行为（catch-and-return 的字符串）能给模型的，现在同样给得到
    expect(promptDump(model, 1)).toContain("[读取失败]");
    expect(promptDump(model, 1)).toMatch(/ENOENT/);
  });

  it("历史重建形状：落盘 ops 投影出的 tool-result 是 error-text（##329 的 b —— 成败落在结构位）", async () => {
    const uri = newUri();
    const model = stubModel([
      readCallReply("c1", "/nonexistent-diy-329/nope.txt"),
      textReply("读不到，换个路径"),
    ]);

    const ops = await run(uri, model);

    // ⚠️ 判据必须取**投影**（ops → 块树 → ModelMessage），不能取 model.doStreamCalls[1].prompt ——
    //   后者是 SDK 自己在**同一轮内**多步循环时携带的消息（execute 抛错 → SDK 自己就造
    //   error-text），与本改动无关：把 b 改回去那条断言照样通过（实测，无判别力）。
    //   b 的落点只在**历史重建**：下一轮请求 / 进程重启后重放 ops 的那份历史，
    //   那才是 diy 自己拼的消息（buildHistory → blocksToMessages）。
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const results = blocksToMessages(store)
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as Array<{ output: { type: string; value: string } }>)[0]!.output);
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("error-text");
    expect(results[0]!.value).toContain("[读取失败]");
  });

  it("工具报错不打断这一轮：后续步照常执行、轮次正常收尾", async () => {
    const uri = newUri();
    const model = stubModel([
      readCallReply("c1", "/nonexistent-diy-329/nope.txt"),
      textReply("换个路径读到了"),
    ]);

    const ops = await run(uri, model);

    // 第二步真跑了：上游收到过 2 次请求，且有它答复的文本块
    expect(model.doStreamCalls).toHaveLength(2);
    expect(
      ops.some(
        (o) =>
          o.op === "delta" &&
          typeof (o.fields as { content?: unknown }).content === "string" &&
          ((o.fields as { content: string }).content.includes("换个路径读到了")),
      ),
    ).toBe(true);
    // 轮次闭合（报错不该让 turn 挂住）
    const turn = ops.find((o) => o.op === "start" && o.kind === "turn");
    expect(turn).toBeTruthy();
    expect(ops.some((o) => o.op === "stop" && o.id === turn!.id)).toBe(true);
  });

  it("成功路径不受影响：正常读取仍是 done + 正文", async () => {
    const uri = newUri();
    // 相对路径按任务 cwd 解析；用绝对路径避免依赖任务 cwd 是否存在
    const real = new URL("./local-agent-read-error.test.ts", import.meta.url).pathname;
    const model = stubModel([readCallReply("c1", real), textReply("看到了")]);

    const ops = await run(uri, model);

    const id = toolIds(ops)[0];
    expect(statusOf(ops, id!)).toBe("done");
    expect(outputOf(ops, id!)).toContain("[文件结束，共");
  });
});
