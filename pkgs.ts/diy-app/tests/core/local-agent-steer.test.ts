// tests/core/local-agent-steer.test.ts
// 🎯 插话（steer）投递时机 —— 用桩模型（ai/test 的 MockLanguageModelV3）离线验证
//
// 为什么要桩：真实 LLM 无法保证"这一步一定调工具、下一步一定给答复"，
// 而插话的两种时机的差别**恰恰只在步/轮边界上**：
//   step 模式 → 在下一个模型步开始前进入 messages（同一轮内）
//   turn 模式 → 当前轮收尾后自动开新一轮
// 桩模型把边界变成确定事件，于是每条断言都指向一个具体契约。
//
// 断言口径统一走"**上游实际收到的 messages**"（mock.doStreamCalls[i].prompt），
// 而不是只查 ops/队列 —— 后者只能证明"我们记了一笔"，前者才证明"模型真的看见了"。

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager, MAX_STEER_ROUNDS } from "../../src/main/services/local-agent";
import { SteerQueue } from "../../src/main/core/steer-queue";
import type { Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_ZEN_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "steer-work"));
});

let seq = 0;
function newUri(): string {
  return createTask({ title: `插话测试 ${++seq}`, project: PROJECT });
}

// ─── 桩模型：按调用序返回预置流 ────────────────────────

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
function textReply(text: string): LanguageModelV3StreamResult {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);
}

/** 一次工具调用（会让 SDK 继续下一步，除非步数用尽） */
function toolCallReply(callId: string, command: string): LanguageModelV3StreamResult {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: callId, toolName: "bash" },
    { type: "tool-input-delta", id: callId, delta: JSON.stringify({ command }) },
    { type: "tool-input-end", id: callId },
    { type: "tool-call", toolCallId: callId, toolName: "bash", input: JSON.stringify({ command }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ]);
}

/** 造一个按序吐流的桩模型；越界复用最末一条（避免测试因多一次请求就崩） */
function stubModel(replies: LanguageModelV3StreamResult[]) {
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(replies[Math.min(call++, replies.length - 1)]!),
  });
  return model;
}

/** 上游第 i 次请求里出现的全部文本（user/assistant 两侧都算，用来判断"模型看见没看见"） */
function promptText(model: MockLanguageModelV3, callIndex: number): string {
  const prompt = model.doStreamCalls[callIndex]?.prompt ?? [];
  const out: string[] = [];
  for (const msg of prompt as Array<{ content: unknown }>) {
    const content = msg.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; text?: string }>) {
        if (typeof part.text === "string") out.push(part.text);
      }
    }
  }
  return out.join("\n");
}

/** 跑一轮对话，返回全部 op */
async function run(
  uri: string,
  message: string,
  model: MockLanguageModelV3,
  mgr: LocalAgentManager = new LocalAgentManager(() => model as unknown as LanguageModel),
): Promise<Op[]> {
  const ops: Op[] = [];
  for await (const op of mgr.chat(uri, message)) ops.push(op);
  return ops;
}

/** 某 kind 的块 id（按出现序） */
const idsOf = (ops: Op[], kind: string): string[] =>
  ops.filter((o) => o.op === "start" && o.kind === kind).map((o) => (o as { id: string }).id);

beforeEach(() => {
  // 队列落盘在任务目录，每个用例用自己的任务 URI，无需清理
});

describe("插话 step 模式：进入下一个模型步", () => {
  it("模型还在调工具时：下一步的请求里就带上了插话；本步的请求里没有", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "step", "插一句：记得用 --no-gpg-sign");
    const model = stubModel([
      toolCallReply("c1", "echo one"),
      textReply("好了"),
    ]);

    await run(uri, "开始干活", model);

    // 第一步：模型还没看到插话（它是在这一步之后才被插进来的）
    expect(promptText(model, 0)).not.toContain("记得用 --no-gpg-sign");
    // 第二步：必须看到 —— 这就是"插入到下一步"
    expect(promptText(model, 1)).toContain("记得用 --no-gpg-sign");
    // 投递后队列清空（否则会被投第二次）
    expect(new SteerQueue().list(uri)).toEqual([]);
  });

  it("模型一步就给出最终答复时：**不往本轮尾巴续**，插话当下一轮的开场白", async () => {
    // 这条是设计取舍的锁定：曾经有过"段末续段"（= dsh 的 turn-stopping 语义）——
    // 模型写完最终答复后，再往**同一个 turn** 里塞一段把 step 插话递出去。
    // 废除它的理由：模型说"做完了"就说明没有下一步了，硬续一段只会得到
    // 「assistant 总结 → user 插话 → assistant 又总结」的夹层；收益仅是早一个
    // **本来就会立刻发生**的轮次边界生效，代价是轮次结构/usage/停止边界都要为夹层做特例。
    const uri = newUri();
    new SteerQueue().add(uri, "step", "补一句：还要跑测试");
    const model = stubModel([textReply("我先答完"), textReply("收到插话后的答复")]);

    const ops = await run(uri, "问个问题", model);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(promptText(model, 1)).toContain("补一句：还要跑测试");
    // 两个**轮次**（不是同一个轮次里的两段）
    const turns = ops.filter((o) => o.op === "start" && o.kind === "turn") as Array<{ id: string }>;
    expect(turns).toHaveLength(2);
    // 第一轮里没有插话块 —— 夹层必须不存在（这正是本条要钉住的）
    const t1 = turns[0]!.id;
    expect(
      ops.some(
        (o) =>
          o.op === "start" && o.kind === "text" && (o as { parent?: string }).parent === t1
            && (o as { meta?: { steer?: string } }).meta?.steer,
      ),
    ).toBe(false);
    // 插话是第二轮的**开场** user 块（文档序第一）
    const t2 = turns[1]!.id;
    const opening = ops.find(
      (o) => o.op === "start" && o.kind === "text" && (o as { parent?: string }).parent === t2,
    ) as { meta?: { steer?: string; steerId?: string } };
    expect(opening.meta?.steer).toBe("step");
    // 块 meta 里带上队列项 id（steer/N），排障时能回查是哪次插话
    expect(opening.meta?.steerId).toMatch(/^steer\/\d+$/);
    expect(new SteerQueue().list(uri)).toEqual([]);
  });

  it("队列为空：不续段（不多打一次上游请求）", async () => {
    const uri = newUri();
    const model = stubModel([textReply("就这样")]);
    await run(uri, "你好", model);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("插话块写进 ops（崩溃/重启后重放仍看得到「谁插的话」）", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "step", "落盘检查");
    const model = stubModel([toolCallReply("c1", "echo x"), textReply("done")]);
    const ops = await run(uri, "开始", model);
    const delta = ops.find(
      (o) => o.op === "delta" && (o as { fields?: { content?: string } }).fields?.content === "落盘检查",
    );
    expect(delta).toBeTruthy();
    // 块 id 出现在 start 里，且带 steer=step
    const id = (delta as { id: string }).id;
    expect(
      ops.some(
        (o) => o.op === "start" && (o as { id?: string }).id === id
          && (o as { meta?: { steer?: string } }).meta?.steer === "step",
      ),
    ).toBe(true);
  });
});

describe("插话 turn 模式：本轮结束后自动开下一轮", () => {
  it("本轮跑完 → 自动开新一轮，插话作为新一轮的 user 消息", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "turn", "下一轮再做这件事");
    const model = stubModel([textReply("第一轮答复"), textReply("第二轮答复")]);

    const ops = await run(uri, "先做第一件事", model);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(promptText(model, 1)).toContain("下一轮再做这件事");
    // 两个 turn：turn 模式的语义就是"新的一次对话"
    expect(idsOf(ops, "turn")).toHaveLength(2);
    const marks = ops.filter(
      (o) => o.op === "start" && (o as { meta?: { steer?: string } }).meta?.steer === "turn",
    );
    expect(marks).toHaveLength(1);
    expect(new SteerQueue().list(uri)).toEqual([]);
  });

  it("两种模式同时排队：按提交顺序一条一条投（轮末 FIFO，不看模式）", async () => {
    // 轮末已经收尾，"下一步"不复存在 → 两种模式此时都只能当下一轮的开场。
    // 于是顺序只由**提交先后**决定（顺序即投递顺序）；若还按 turn 优先，后提交的会插队。
    const uri = newUri();
    const q = new SteerQueue();
    q.add(uri, "step", "先提交的");
    q.add(uri, "turn", "后提交的");
    const model = stubModel([textReply("答复1"), textReply("答复2"), textReply("答复3")]);
    const ops = await run(uri, "开始", model);

    expect(model.doStreamCalls).toHaveLength(3); // 首轮 + 两条插话各一轮
    expect(promptText(model, 0)).not.toContain("先提交的");
    expect(promptText(model, 1)).toContain("先提交的");
    expect(promptText(model, 2)).toContain("后提交的");
    expect(new SteerQueue().list(uri)).toEqual([]);
    // 三轮（每条插话各开一轮），模式只影响标记文案、不影响轮次结构
    expect(idsOf(ops, "turn")).toHaveLength(3);
  });

  it("连续插话到轮次上限：剩余插话留在队列里 + 显式 error 块（不静默吞）", async () => {
    const uri = newUri();
    const q = new SteerQueue();
    for (let i = 0; i < MAX_STEER_ROUNDS + 2; i++) q.add(uri, "turn", `第${i}条`);
    const model = stubModel([textReply("答复")]);

    const ops = await run(uri, "开始", model);

    // 算术（10 条入队，上限 8）：
    //   第 1 次请求 = 用户自己的消息（不消耗队列）
    //   第 2..8 次   = 7 条插话各自开一轮（每轮末尾取一条）
    //   → 共 8 次请求 = MAX_STEER_ROUNDS；第 8 轮末尾判到上限，**不取项**直接收尾
    //   → 队列剩 10 - 7 = 3 条
    // 关键：上限分支只读队列不取项。取项 = 取出即落盘删除（投递的唯一入口），
    // 取出来再丢弃就是真丢用户的话。
    expect(model.doStreamCalls).toHaveLength(MAX_STEER_ROUNDS);
    expect(new SteerQueue().list(uri).map((i) => i.text)).toEqual(["第7条", "第8条", "第9条"]);
    const err = ops.find((o) => o.op === "start" && o.kind === "error" && (o as { meta?: { source?: string } }).meta?.source === "steer");
    expect(err).toBeTruthy();
  });

  it("没有插话就不多开轮（单轮结束即止）", async () => {
    const uri = newUri();
    const model = stubModel([textReply("一次性答复")]);
    const ops = await run(uri, "你好", model);
    expect(idsOf(ops, "turn")).toHaveLength(1);
    expect(idsOf(ops, "step")).toHaveLength(1);
  });
});

describe("插话不破坏既有会话语义", () => {
  it("工具链路完整：tool 块 done + turn 收尾（stop）+ usage 回填", async () => {
    const uri = newUri();
    const model = stubModel([toolCallReply("c1", "echo hi"), textReply("完成")]);
    const ops = await run(uri, "跑个命令", model);
    expect(ops.some((o) => o.op === "patch" && (o as { fields?: { status?: string } }).fields?.status === "done")).toBe(true);
    const turnId = idsOf(ops, "turn")[0]!;
    expect(ops.some((o) => o.op === "stop" && (o as { id: string }).id === turnId)).toBe(true);
    expect(ops.some((o) => o.op === "patch" && (o as { fields?: { usage?: unknown } }).fields?.usage)).toBe(true);
  });

  it("投递过的插话不会在下一轮重复出现（取出即落盘删除）", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "step", "只该出现一次");
    const model = stubModel([toolCallReply("c1", "echo a"), textReply("完成")]);
    await run(uri, "开始", model);
    // 第二次对话（新 manager 实例 = 重启，队列从盘上读）
    const mgr2 = new LocalAgentManager(() => model as unknown as LanguageModel);
    const model2 = stubModel([textReply("第二次答复")]);
    await run(uri, "再来一次", model2, mgr2);
    expect(promptText(model2, 0)).not.toContain("只该出现一次");
  });
});
