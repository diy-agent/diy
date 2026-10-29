// tests/core/local-agent-bash-cancel.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##375：取消（用户点停止）必须串到**工具执行**：命令真被杀（含子进程）+ 工具块落终态
//
// 现象（##332 实测遗留）：`cancel()` 只断了 LLM 流 —— bash 命令照跑满，
//   工具块停在 status:"running"（既非 done 也非 error），UI 上就是「停不掉的工具行」。
//
// 本文件先立**判据**（红），再验修复（绿）：
//   ① 取消后命令的**子孙进程**也死：判据 = 后台子壳的落地文件在 2s 后仍不存在
//      （`(sleep 2; echo late > M) & wait` —— 只杀 bash 主进程时子壳变孤儿、2s 后照样写文件）；
//   ② 轮次**不等命令跑满**（取消后 < 1.5s 收尾，命令本身要 2s）；
//   ③ 工具块落到**显式终态**（interrupted / done / error），不许停在 running。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import {
  BlockStore,
  blocksToMessages,
  INTERRUPTED_STATUS,
  INTERRUPTED_TOOL_NOTICE,
  type Op,
} from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "bash-cancel-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `bash 取消 ${++seq}`, project: PROJECT });

// ─── 桩模型（照 local-agent-bash-exit.test.ts） ─────────────

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

const textReply = (text: string): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);

const bashCallReply = (callId: string, command: string, extra: Record<string, unknown> = {}): LanguageModelV3StreamResult =>
  stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: callId, toolName: "bash" },
    { type: "tool-input-delta", id: callId, delta: JSON.stringify({ command, ...extra }) },
    { type: "tool-input-end", id: callId },
    { type: "tool-call", toolCallId: callId, toolName: "bash", input: JSON.stringify({ command, ...extra }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ]);

function stubModel(replies: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(replies[Math.min(call++, replies.length - 1)]!),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(10);
  }
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

const stopped = (ops: Op[], id: string): boolean => ops.some((o) => o.op === "stop" && o.id === id);

/** 某个块的 output 终值（走块树折叠 —— delta 与 patch 两条路都覆盖） */
const outputOf = (ops: Op[], id: string): string => {
  const store = new BlockStore();
  for (const op of ops) store.apply(op);
  const v = store.blocks.get(id)?.output;
  return typeof v === "string" ? v : "";
};

/** 轮次的结束原因（最后一次 patch 为准） */
const endReasonOf = (ops: Op[], turnId: string): { type?: string; source?: string } | undefined => {
  let last: { type?: string; source?: string } | undefined;
  for (const op of ops) {
    if (op.op !== "patch" || op.id !== turnId) continue;
    const r = (op.fields as { endReason?: { type?: string; data?: { source?: string } } }).endReason;
    if (r) last = { type: r.type, source: r.data?.source };
  }
  return last;
};

/** 跑一轮（不取消），等它自己收尾 */
async function run(uri: string, model: MockLanguageModelV3): Promise<Op[]> {
  const ops: Op[] = [];
  const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
  for await (const op of mgr.chat(uri, "跑条命令")) ops.push(op);
  return ops;
}

const toolIds = (ops: Op[]): string[] =>
  ops.filter((o) => o.op === "start" && o.kind === "tool").map((o) => (o as { id: string }).id);

/**
 * 跑一轮，在 bash 工具块出现后 `cancelAfterMs` 毫秒点「停止」。
 * 返回 ops 与取消时刻（用于算「收尾等了多久」）。
 */
async function runAndCancel(
  uri: string,
  model: MockLanguageModelV3,
  cancelAfterMs: number,
): Promise<{ ops: Op[]; cancelAt: number; endAt: number }> {
  const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
  const ops: Op[] = [];
  const consuming = (async () => {
    for await (const op of mgr.chat(uri, "跑条命令")) ops.push(op);
  })();
  await waitFor(() => toolIds(ops).length > 0, 5000);
  await sleep(cancelAfterMs);
  const cancelAt = Date.now();
  expect(mgr.cancel(uri)).toBe(true);
  await consuming;
  return { ops, cancelAt, endAt: Date.now() };
}

describe("取消串到 bash 工具执行（##375）", () => {
  it("取消后**子进程**也死：命令的落地文件永不出现", async () => {
    const uri = newUri();
    const marker = join(tmpdir(), `t375-cancel-child-${Date.now()}-${seq}.txt`);
    // 子壳与 bash 主进程同组；只杀 bash 时它变孤儿，2s 后仍会写文件
    const model = stubModel([bashCallReply("c1", `(sleep 2; echo late > ${marker}) & wait`), textReply("x")]);

    const { cancelAt, endAt } = await runAndCancel(uri, model, 200);

    // ② 轮次不等命令跑满（命令要 2s，收尾必须远早于此）
    expect(endAt - cancelAt).toBeLessThan(1500);
    // ① 子进程真被杀：等到命令本该写完的时刻再断言
    await sleep(2500);
    expect(existsSync(marker)).toBe(false);
  });

  it("取消后工具块落到显式终态（不是 running）", async () => {
    const uri = newUri();
    const marker = join(tmpdir(), `t375-cancel-status-${Date.now()}-${seq}.txt`);
    const model = stubModel([bashCallReply("c1", `(sleep 2; echo late > ${marker}) & wait`), textReply("x")]);

    const { ops } = await runAndCancel(uri, model, 200);

    const id = toolIds(ops)[0];
    expect(id).toBeTruthy();
    // 终态恰好是「中断」：不是 running（症状），也不许误判成 error（那是"命令失败"，语义不同 ——
    // 模型会据此换路子重试）/ done（那是"跑完了"，纯属撒谎）
    expect(statusOf(ops, id!)).toBe(INTERRUPTED_STATUS);
    expect(outputOf(ops, id!)).toBe(INTERRUPTED_TOOL_NOTICE);
    expect(stopped(ops, id!)).toBe(true);
    // 轮次本身也要正常闭合（取消是预期收尾，不是 error）
    const turn = ops.find((o) => o.op === "start" && o.kind === "turn");
    expect(turn).toBeTruthy();
    expect(stopped(ops, turn!.id)).toBe(true);
    expect(endReasonOf(ops, turn!.id)).toEqual({ type: "aborted", source: "user" });
  });

  it("投递形状：被取消的 tool 块是 text + origin=interrupted（不是 error-text）", async () => {
    const uri = newUri();
    const marker = join(tmpdir(), `t375-cancel-proj-${Date.now()}-${seq}.txt`);
    const model = stubModel([bashCallReply("c1", `(sleep 2; echo late > ${marker}) & wait`), textReply("x")]);

    const { ops } = await runAndCancel(uri, model, 200);

    // tool-call ↔ tool-result 的配对铁律：下一轮重建历史时必须有这一条，否则 provider 拒整份历史
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const results = blocksToMessages(store, { withOrigin: true })
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as Array<{ output: { type: string; value: string }; origin?: string }>)[0]!);
    expect(results).toHaveLength(1);
    expect(results[0]!.output.type).toBe("text"); // 中断 ≠ 失败（error-text）
    expect(results[0]!.output.value).toBe(INTERRUPTED_TOOL_NOTICE);
    expect(results[0]!.origin).toBe("interrupted");
  });

  it("超时同样杀整组（同类孤儿缺口的顺手锁）：[命令超时被杀] 语义不变", async () => {
    // ##454：缺省不设超时，限时只能由这一步的 `timeout` 实参指定（env 不再是工具缺省）
    const uri = newUri();
    const marker = join(tmpdir(), `t375-timeout-child-${Date.now()}-${seq}.txt`);
    const model = stubModel([
      bashCallReply("c1", `(sleep 2; echo late > ${marker}) & wait`, { timeout: 500 }),
      textReply("太慢"),
    ]);

    const ops = await run(uri, model);

    const id = toolIds(ops)[0];
    expect(id).toBeTruthy();
    expect(outputOf(ops, id!)).toContain("[命令超时被杀]"); // 既有语义（##332 ②）
    expect(statusOf(ops, id!)).toBe("done");
    await sleep(2500);
    expect(existsSync(marker)).toBe(false); // 子女进程也被带走
  });
});
