// tests/core/turn-gate.test.ts
// 🎯 开轮准入（##400）：内核只问「能不能开轮」，判据由上层注入 —— 生产策略 = 终态任务拒绝。
//
// 为什么这些断言这样写：
//   · 「零请求」用桩模型的 `doStreamCalls.length` 钉（不是看有没有 error op）——
//     只有它才能证明**费用没发生**；
//   · 「无新落盘」比 ops.jsonl 的字节数（拒绝不是这个会话发生的事，不许进史书）；
//   · 「无 turnId」= 流里没有 kind=turn 的 start（本轮次根本没建 TurnRun）；
//   · 对照组（active / 假 gate 全 allow）与反证（不注入 gate）各一条：证明拦截来自
//     **注入的策略**，而不是别处顺手写死的判据，也证明扩展点默认零影响。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask, updateTask } from "../../src/main/core/task";
import { taskTurnGate } from "../../src/main/core/turn-gate";
import { opsFile } from "../../src/main/core/local-paths";
import { SteerQueue } from "../../src/main/core/steer-queue";
import { LocalAgentManager, createLocalAgent } from "../../src/main/services/local-agent";
import type { Op } from "../../src/main/services/local-blocks";
import type { TurnGate, TurnGateDecision, TurnGateInput } from "../../src/shared/turn-gate";

beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不出网，但 chat 入口会校验
});

let PROJECT = "1";
beforeAll(() => {
  PROJECT = createProject(join(diyHome(), "turn-gate-work"));
});

let seq = 0;
function newUri(state: string = "active"): string {
  const uri = createTask({ title: `准入测试 ${++seq}`, project: PROJECT });
  updateTask(uri, { state });
  return uri;
}

// ─── 桩模型（与 local-agent-steer 同一套最小形状）────

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

function stubModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(textReply("答复")),
  });
}

function manager(model: MockLanguageModelV3, gate?: TurnGate): LocalAgentManager {
  return new LocalAgentManager(() => model as unknown as LanguageModel, gate);
}

/** 跑完一整条流，收全部 op */
async function collect(gen: AsyncGenerator<Op>): Promise<Op[]> {
  const ops: Op[] = [];
  for await (const op of gen) ops.push(op);
  return ops;
}

const errorStarts = (ops: Op[]) => ops.filter((o) => o.op === "start" && o.kind === "error");
const turnStarts = (ops: Op[]) => ops.filter((o) => o.op === "start" && o.kind === "turn");

/** ops.jsonl 的字节数（不存在 = 0）—— 「拒绝不留盘」的判据 */
function opsSize(uri: string): number {
  const f = opsFile(uri);
  return existsSync(f) ? statSync(f).size : 0;
}

// ─── 用例 ──────────────────────────────────────────

describe("生产策略：终态任务不许开轮（##400）", () => {
  it("done ⇒ 一条 error 块、零请求、无 turnId、无新落盘", async () => {
    const uri = newUri("done");
    const model = stubModel();
    const mgr = manager(model, taskTurnGate);
    const before = opsSize(uri);

    const ops = await collect(mgr.chat(uri, "还在吗"));

    expect(errorStarts(ops)).toHaveLength(1);
    // 拒绝文案带「怎么续」（##391 三问里的详情）
    const msg = ops.find((o) => o.op === "delta")!;
    expect(JSON.stringify(msg.fields)).toContain("diy task edit");
    // 没建轮次、没发请求、没占注册表、没落盘
    expect(turnStarts(ops)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(mgr.busy(uri)).toBe(false);
    expect(opsSize(uri)).toBe(before);
  });

  it("active ⇒ 正常开轮（对照组）", async () => {
    const uri = newUri("active");
    const model = stubModel();
    const ops = await collect(manager(model, taskTurnGate).chat(uri, "干活"));

    expect(turnStarts(ops)).toHaveLength(1);
    expect(errorStarts(ops)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("chatQueued 同拦（留言唤醒分支）", async () => {
    const uri = newUri("done");
    new SteerQueue().add(uri, "next-turn", "排着的留言");
    const model = stubModel();
    const mgr = manager(model, taskTurnGate);

    const ops = await collect(mgr.chatQueued(uri));

    expect(errorStarts(ops)).toHaveLength(1);
    expect(turnStarts(ops)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
    // 留言仍安好在队列里（拒绝 ≠ 吞消息）
    expect(new SteerQueue().list(uri).map((i) => i.text)).toEqual(["排着的留言"]);
  });

  it("假 gate 全 allow ⇒ 行为与改动前一致（扩展点默认零影响）", async () => {
    const uri = newUri("done"); // 状态是 done，但策略说可以
    const seen: TurnGateInput[] = [];
    const allowAll: TurnGate = (input) => {
      seen.push(input);
      return { allow: true };
    };
    const model = stubModel();
    const ops = await collect(manager(model, allowAll).chat(uri, "你好"));

    expect(turnStarts(ops)).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(seen).toEqual([{ sessionUri: uri, kind: "chat" }]);
  });

  it("不注入 gate ⇒ 一次都不问，done 任务照样开轮（反证：拦截来自注入的策略）", async () => {
    const uri = newUri("done");
    const model = stubModel();
    const ops = await collect(manager(model).chat(uri, "你好"));

    expect(turnStarts(ops)).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("生产装配（createLocalAgent 缺省）⇒ done 被拦（装配漏注入 ⇒ 本条必红）", async () => {
    const uri = newUri("done");
    const model = stubModel();
    const ops = await collect(
      createLocalAgent({ modelResolver: () => model as unknown as LanguageModel }).chat(uri, "还在吗"),
    );
    expect(errorStarts(ops)).toHaveLength(1);
    expect(turnStarts(ops)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("shelved 不拦；cancelled / closed 拦", async () => {
    const model = stubModel();
    const ran = async (state: string): Promise<boolean> => {
      const uri = newUri(state);
      const ops = await collect(manager(model, taskTurnGate).chat(uri, "hi"));
      return turnStarts(ops).length > 0;
    };
    expect(await ran("shelved")).toBe(true);
    expect(await ran("cancelled")).toBe(false);
    expect(await ran("closed")).toBe(false);
  });

  it("策略本身：code 固定 session/closed、任务不存在则放行", () => {
    const uri = newUri("done");
    const d = taskTurnGate({ sessionUri: uri, kind: "chat" });
    expect(d).toMatchObject({ allow: false, code: "session/closed" });
    const unknown: TurnGateDecision = taskTurnGate({ sessionUri: "projects/999/tasks/999", kind: "chat" });
    expect(unknown).toEqual({ allow: true });
  });
});
