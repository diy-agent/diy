// tests/core/local-agent-bash-exit.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##353：bash 工具**非零退出**的工具行 ✓/✗ 口径（复议 ##332 ①）
//
// 现象：`cd … && fd … | grep -i block` 退出码 1（无匹配）却标 ✓，正文还打印
//   `Command failed: /bin/bash -c …` —— 状态与结果自相矛盾。
//
// 口径（本任务定，真源在 `runBash` 头注）：
//   · **非零退出 + 有错误输出**（stderr 非空）⇒ 失败：execute 抛 → SDK 发 tool-error →
//     ops `status:"error"` ⇒ UI 画 ✗ 且恒展开；
//   · **非零退出 + 无错误输出** ⇒ 数据（`grep`/`fd`/`rg`/`test` 未命中 = 退出 1 且静默）：
//     保持 `status:"done"`，正文保留 `[退出码 N]` 供模型改命令；
//   · 正文不再兜底塞 Node 的 `err.message`（`Command failed: /bin/bash -c …` 那句的由来）。
//
// 为什么必须端到端（照 ##329 的 local-agent-read-error.test.ts）：断言的对象是
//   「execute 抛/不抛 → SDK 到底发 tool-error 还是 tool-result → ops 落哪个 status」这条链路，
//   单测只能证明"抛了"。
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
  PROJECT = createProject(join(diyHome(), "bash-exit-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `bash 退出码 ${++seq}`, project: PROJECT });

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

/** 一次 bash 工具调用 */
const bashCallReply = (callId: string, command: string): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: callId, toolName: "bash" },
    { type: "tool-input-delta", id: callId, delta: JSON.stringify({ command }) },
    { type: "tool-input-end", id: callId },
    { type: "tool-call", toolCallId: callId, toolName: "bash", input: JSON.stringify({ command }) },
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

/** 上游第 i 次请求的整份 prompt 序列化（判断"模型看见没看见"） */
function promptDump(model: MockLanguageModelV3, callIndex: number): string {
  return JSON.stringify(model.doStreamCalls[callIndex]?.prompt ?? []);
}

async function run(uri: string, model: MockLanguageModelV3): Promise<Op[]> {
  const ops: Op[] = [];
  const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
  for await (const op of mgr.chat(uri, "跑条命令")) ops.push(op);
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

// ─── 用例命令 ──────────────────────────────────────────
// ① 非零退出 + 有错误输出（stderr 非空）
const CMD_ERR = "echo 炸了-353 >&2; exit 1";
// ② 非零退出 + 无错误输出（grep 无匹配 = 退出 1 且静默 —— 用户现象原形）
const CMD_NOMATCH = "grep -q zzz-一定不匹配-353 /dev/null";
// ③ 成功
const CMD_OK = "echo 你好-353";

describe("bash 非零退出的 ✓/✗（##353）", () => {
  it("非零退出 + 有错误输出 → status:error（✗），诊断在正文", async () => {
    const uri = newUri();
    const model = stubModel([bashCallReply("c1", CMD_ERR), textReply("命令炸了")]);

    const ops = await run(uri, model);

    const id = toolIds(ops)[0];
    expect(id).toBeTruthy();
    expect(statusOf(ops, id!)).toBe("error");
    expect(outputOf(ops, id!)).toContain("[退出码 1]");
    expect(outputOf(ops, id!)).toContain("炸了-353");
    // 不能同时又落一条 done —— UI 取最后一次 patch，两条并存说明分支串了
    expect(
      ops.filter((o) => o.op === "patch" && o.id === id && (o.fields as { status?: string }).status === "done"),
    ).toHaveLength(0);
  });

  it("非零退出 + 无错误输出（grep 无匹配）→ status:done（✓），退出码仍回喂、正文无 Command failed", async () => {
    const uri = newUri();
    const model = stubModel([bashCallReply("c1", CMD_NOMATCH), textReply("没匹配到")]);

    const ops = await run(uri, model);

    const id = toolIds(ops)[0];
    expect(id).toBeTruthy();
    expect(statusOf(ops, id!)).toBe("done");
    // 退出码仍是数据（模型要靠它判断"没查到"）
    expect(outputOf(ops, id!)).toContain("[退出码 1]");
    // 矛盾的来源：Node 的 `Command failed: /bin/bash -c …` 不再被当命令输出塞进来
    expect(outputOf(ops, id!)).not.toContain("Command failed");
  });

  it("成功路径不受影响：done + 正文", async () => {
    const uri = newUri();
    const model = stubModel([bashCallReply("c1", CMD_OK), textReply("好了")]);

    const ops = await run(uri, model);

    const id = toolIds(ops)[0];
    expect(statusOf(ops, id!)).toBe("done");
    expect(outputOf(ops, id!)).toContain("你好-353");
  });

  it("模型侧：失败诊断随 tool 结果回灌给下一步", async () => {
    const uri = newUri();
    const model = stubModel([bashCallReply("c1", CMD_ERR), textReply("收到")]);

    await run(uri, model);

    expect(promptDump(model, 1)).toContain("[退出码 1]");
    expect(promptDump(model, 1)).toContain("炸了-353");
  });

  it("历史重建形状：失败 tool-result 是 error-text（##329 的 b —— 成败落在结构位）", async () => {
    const uri = newUri();
    const model = stubModel([bashCallReply("c1", CMD_ERR), textReply("收到")]);

    const ops = await run(uri, model);

    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const results = blocksToMessages(store)
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as Array<{ output: { type: string; value: string } }>)[0]!.output);
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("error-text");
    expect(results[0]!.value).toContain("[退出码 1]");
  });

  it("报错不打断这一轮：后续步照常执行、轮次正常收尾", async () => {
    const uri = newUri();
    const model = stubModel([bashCallReply("c1", CMD_ERR), textReply("换条命令试试")]);

    const ops = await run(uri, model);

    expect(model.doStreamCalls).toHaveLength(2);
    const turn = ops.find((o) => o.op === "start" && o.kind === "turn");
    expect(turn).toBeTruthy();
    expect(ops.some((o) => o.op === "stop" && o.id === turn!.id)).toBe(true);
  });
});
