// tests/core/local-agent-steer.test.ts
// 🎯 插话（steer）投递时机 —— 用桩模型（ai/test 的 MockLanguageModelV3）离线验证
//
// 为什么要桩：真实 LLM 无法保证"这一步一定调工具、下一步一定给答复"，
// 而插话的两种时机的差别**恰恰只在步/轮边界上**：
//   next-step → 下一个模型步开始前把**队列里所有 next-step** 一次注入（同一轮内）
//   next-turn → 当前轮收尾后自动开新一轮（与 next-step 一样整批投，差别只在投递点）
// 桩模型把边界变成确定事件，于是每条断言都指向一个具体契约。
//
// 断言口径统一走"**上游实际收到的 messages**"（mock.doStreamCalls[i].prompt），
// 而不是只查 ops/队列 —— 后者只能证明"我们记了一笔"，前者才证明"模型真的看见了"。

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager, MAX_STEER_ROUNDS } from "../../src/main/services/local-agent";
import { activeTurnList } from "../../src/main/services/runtime-context";
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { SteerQueue } from "../../src/main/core/steer-queue";
import { BlockStore, type Op } from "../../src/main/services/local-blocks";

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

describe("超预算早退：不记账、不投递（用户的话必须还在队列里）", () => {
  it("系统上下文越框时不发请求：无开场块、插话未出队、轮次仍闭合", async () => {
    const uri = newUri();
    // ⚠️ 真发已切 Context Tree 投递：预算按**投递**的 system 容器算（稳定项，含 AGENTS.md 链），
    // 模版覆盖（identity.md 那类）已不进真发 —— 与 cli.intent.template 的超预算用例同手法：
    // 给链上塞大内容。链必含 $DIY_HOME/AGENTS.md（appLevel 无条件进链；任务自己的 AGENTS.md
    // 被 chainOf skip，写任务目录不生效）。
    const agentsFile = join(diyHome(), "AGENTS.md");
    writeFileSync(agentsFile, "x".repeat(70 * 1024), "utf-8");
    try {
      const q = new SteerQueue();
      q.add(uri, "next-turn", "排队等着的话");
      const model = stubModel([textReply("答复")]);

      const ops = await run(uri, "开始", model);

      // 确实走了超预算分支，且**根本没发请求**
      expect(
        ops.some((o) => o.op === "start" && o.kind === "error" && (o as { meta?: { source?: string } }).meta?.source === "budget"),
      ).toBe(true);
      expect(model.doStreamCalls).toHaveLength(0);

      // 回归 P1：插话**没有**被出队吞掉（曾经把出队放在判预算之前 → 用户的话凭空消失）
      expect(new SteerQueue().list(uri).map((i) => i.text)).toEqual(["排队等着的话"]);

      // 回归 P1：也不许留下开场 user 块（模型没见过的话不能进对话流，
      // 否则 blocksToMessages 会把它当真实历史，发给后续每一轮）
      expect(
        ops.some(
          (o) => o.op === "start" && o.kind === "text" && (o as { meta?: { role?: string } }).meta?.role === "user",
        ),
      ).toBe(false);

      // 拒绝发送也是一轮完整生命周期：必须闭合，不留僵尸轮次
      const turn = ops.find((o) => o.op === "start" && o.kind === "turn");
      expect(turn).toBeTruthy();
      expect(ops.some((o) => o.op === "stop" && o.id === turn!.id)).toBe(true);
    } finally {
      rmSync(agentsFile, { force: true });
    }
  });
});

describe("插话 next-step 模式：进入下一个模型步", () => {
  it("模型还在调工具时：下一步的请求里就带上了插话；本步的请求里没有", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "next-step", "插一句：记得用 --no-gpg-sign");
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
    new SteerQueue().add(uri, "next-step", "补一句：还要跑测试");
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
    expect(opening.meta?.steer).toBe("next-step");
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
    new SteerQueue().add(uri, "next-step", "落盘检查");
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
          && (o as { meta?: { steer?: string } }).meta?.steer === "next-step",
      ),
    ).toBe(true);
  });
});

describe("插话 next-turn 模式：本轮结束后自动开下一轮", () => {
  it("本轮跑完 → 自动开新一轮，插话作为新一轮的 user 消息", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "next-turn", "下一轮再做这件事");
    const model = stubModel([textReply("第一轮答复"), textReply("第二轮答复")]);

    const ops = await run(uri, "先做第一件事", model);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(promptText(model, 1)).toContain("下一轮再做这件事");
    // 两个 turn：turn 模式的语义就是"新的一次对话"
    expect(idsOf(ops, "turn")).toHaveLength(2);
    const marks = ops.filter(
      (o) => o.op === "start" && (o as { meta?: { steer?: string } }).meta?.steer === "next-turn",
    );
    expect(marks).toHaveLength(1);
    expect(new SteerQueue().list(uri)).toEqual([]);
  });

  it("同一轮内多条 next-step：下一步一次性全投（不是一条一步）", async () => {
    // 对齐 dsh 的 claim()：next-step 在步边界一次全取（多条合并成同一批）。
    const uri = newUri();
    const q = new SteerQueue();
    q.add(uri, "next-step", "step 甲");
    q.add(uri, "next-step", "step 乙");
    const model = stubModel([toolCallReply("c1", "echo x"), textReply("完成")]);
    const ops = await run(uri, "开始", model);

    // 两条都在**第二次请求**里（同一步），而不是各占一步
    expect(model.doStreamCalls).toHaveLength(2);
    expect(promptText(model, 0)).not.toContain("step 甲");
    expect(promptText(model, 1)).toContain("step 甲");
    expect(promptText(model, 1)).toContain("step 乙");
    expect(new SteerQueue().list(uri)).toEqual([]);
    // 两个插话块都在（各带 steer=next-step 标记）
    const steerBlocks = ops.filter(
      (o) => o.op === "start" && (o as { meta?: { steer?: string } }).meta?.steer === "next-step",
    );
    expect(steerBlocks).toHaveLength(2);
  });

  it("轮末整批：队列里剩下的全部（两种模式）作为下一轮开场一次性发出", async () => {
    const uri = newUri();
    const q = new SteerQueue();
    q.add(uri, "next-step", "先提交的 step");
    q.add(uri, "next-step", "再一条 step");
    q.add(uri, "next-turn", "后提交的 turn");
    const model = stubModel([textReply("答复1"), textReply("答复2")]);
    const ops = await run(uri, "开始", model);

    // 首轮一条请求；轮末把 3 条一次投进第二轮 → 共 2 次请求（不再"每轮一条"）
    expect(model.doStreamCalls).toHaveLength(2);
    const second = promptText(model, 1);
    expect(second).toContain("先提交的 step");
    expect(second).toContain("再一条 step");
    expect(second).toContain("后提交的 turn");
    expect(new SteerQueue().list(uri)).toEqual([]);
    // 只开两轮：整批投递把多条合并进同一轮
    expect(idsOf(ops, "turn")).toHaveLength(2);
    // 三条都是第二轮的**开场块**（同一轮内多个 user 块，按队列顺序）
    const opening = ops.filter(
      (o) => o.op === "start" && o.kind === "text" && (o as { meta?: { role?: string } }).meta?.role === "user",
    ) as Array<{ id: string }>;
    const secondTurnId = idsOf(ops, "turn")[1]!;
    expect(opening.filter((o) => o.id.startsWith(secondTurnId))).toHaveLength(3);
  });

  it("排队多条 next-turn：一次发完，不是一轮一条", async () => {
    const uri = newUri();
    const q = new SteerQueue();
    q.add(uri, "next-turn", "第一句");
    q.add(uri, "next-turn", "第二句");
    q.add(uri, "next-turn", "第三句");
    const model = stubModel([textReply("答复1"), textReply("答复2")]);
    await run(uri, "开始", model);

    // 关键：2 次请求（= 1 个续轮），而不是 4 次（每轮一条）
    expect(model.doStreamCalls).toHaveLength(2);
    const second = promptText(model, 1);
    for (const t of ["第一句", "第二句", "第三句"]) expect(second).toContain(t);
    expect(new SteerQueue().list(uri)).toEqual([]);
  });

  it("连续插话到轮次上限：剩余插话留在队列里 + 显式 error 块（不静默吞）", async () => {
    const uri = newUri();
    const q = new SteerQueue();
    q.add(uri, "next-turn", "第0条");
    // 上限只在"本轮里又冒出新的插话"时才可能撞上：整批投递已经把轮末积压一次消化完，
    // 所以让桩模型每次请求都再排一条（模拟用户在本轮里继续插话）。
    let enqueued = 0;
    const model = new MockLanguageModelV3({
      provider: "stub",
      modelId: "stub-model",
      doStream: () => {
        enqueued += 1;
        q.add(uri, "next-turn", `第${enqueued}条`);
        return Promise.resolve(textReply("答复"));
      },
    });

    const ops = await run(uri, "开始", model);

    // 第 1 次请求 = 用户自己的消息；第 2..8 次 = 每轮吃掉上一轮新排的那条
    // → 共 MAX_STEER_ROUNDS 次请求；第 8 轮末尾判到上限，**什么都不取**直接收尾
    expect(model.doStreamCalls).toHaveLength(MAX_STEER_ROUNDS);
    // 上限那一刻新排的那条还在盘上（可取消 / 再发一条消息触发）
    expect(new SteerQueue().list(uri).map((i) => i.text)).toEqual([`第${MAX_STEER_ROUNDS}条`]);
    const err = ops.find((o) => o.op === "start" && o.kind === "error" && (o as { meta?: { source?: string } }).meta?.source === "steer") as
      | { op: "start"; id: string; parent?: string }
      | undefined;
    expect(err).toBeTruthy();

    // ── 呈现断言：提示必须**挂在本轮 turn 下**，不能是根块 ──
    // 只断言"op 存在"不够：曾经这条 op 不带 parent，fold 后成了**根块**，而 UI 的根渲染
    // 分支只认 turn → 用户看到的是「[未知根 error]」，等于提示没写（设计承诺的
    // "显式提示、不静默吞"落空）。所以这里按 UI 的读法（fold 后的块树）断言归属。
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    expect(err!.parent).toBeTruthy();
    const errBlock = store.blocks.get(err!.id)!;
    expect(errBlock.parent).toBe(err!.parent);
    expect(store.blocks.get(errBlock.parent!)!.kind).toBe("turn");
    // 且它是**最后一个** turn 的下挂块（提示属于撞上限的那一轮，不是首轮）
    const roots = store.roots();
    expect(roots.every((r) => r.kind === "turn")).toBe(true);
    expect(roots[roots.length - 1]!.id).toBe(errBlock.parent);
    // id 唯一性 / 折叠无 issue：曾经 id 用「队列首条 id + -limit」，同任务二次撞上限
    // 且首条未变时会撞车 → 「重复 start」被丢弃、随后的 delta 却累进旧块（文案拼接）
    expect(err!.id).toContain("limit");
    expect(store.issues).toEqual([]);
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
    new SteerQueue().add(uri, "next-step", "只该出现一次");
    const model = stubModel([toolCallReply("c1", "echo a"), textReply("完成")]);
    await run(uri, "开始", model);
    // 第二次对话（新 manager 实例 = 重启，队列从盘上读）
    const mgr2 = new LocalAgentManager(() => model as unknown as LanguageModel);
    const model2 = stubModel([textReply("第二次答复")]);
    await run(uri, "再来一次", model2, mgr2);
    expect(promptText(model2, 0)).not.toContain("只该出现一次");
  });
});

// ─── 消费端断开（切页/刷新/关窗/CLI 被杀）也要收尾 ─────
//
// 这条路径此前完全没测，所以一个"把 closeTurn 从 finally 挪到 try 之后"的重构
// 能悄悄把收尾整段跳过：生成器在 return 展开下，try 之后的顺序语句一律不执行。
// 后果三条（都不可自愈）：ops 缺 turn 的 stop（UI 显示"本轮未完成"）、
// activeTurns 留僵尸轮次、审计缺 turn-end。
//
// 断言口径刻意选"**独立于生成器流本身**的落点"：磁盘上的 ops.jsonl 与内存里的
// activeTurnList —— 断开之后没人再消费 op，只有这些副作用能证明收尾真的跑了。

/** 该任务的 ops.jsonl 路径（keyOf 规则：字符净化前 64 + sha256 前 12） */
function opsPathOf(uri: string): string {
  const readable = uri.replace(/[^\w.-]+/g, "_").slice(0, 64);
  const sum = createHash("sha256").update(uri).digest("hex").slice(0, 12);
  return join(diyHome(), "local", `${readable}-${sum}.ops.jsonl`);
}
const opsFileOf = (uri: string): Promise<string> => Promise.resolve(opsPathOf(uri));

/** 读该任务的 ops.jsonl 原始文本（不存在 = 空串） */
function opsRaw(uri: string): string {
  const fp = opsPathOf(uri);
  return existsSync(fp) ? readFileSync(fp, "utf-8") : "";
}

/** 审计文件中该任务的 turn-end 条数 */
function turnEndAuditCount(uri: string): number {
  const fp = join(diyHome(), "log", "agent-bash.jsonl");
  if (!existsSync(fp)) return 0;
  return readFileSync(fp, "utf-8")
    .split("\n")
    .filter((l) => l.includes('"turn-end"') && l.includes(uri)).length;
}

/** 桩模型：流挂住不回（模拟"生成进行中"），由调用方决定何时断开 */
function hangingModel() {
  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      c.enqueue({ type: "text-start", id: "t" });
      c.enqueue({ type: "text-delta", id: "t", delta: "开始" });
      // 故意不 close：消费端会在流中途断开
    },
  });
  return new MockLanguageModelV3({ provider: "stub", modelId: "stub", doStream: () => Promise.resolve({ stream }) });
}

describe("消费端断开（return 展开）也必须收尾", () => {
  it("断开后：turn 的 stop 落盘、activeTurns 摘除、turn-end 审计留痕", async () => {
    const uri = newUri();
    const model = hangingModel();
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);

    const it = mgr.chat(uri, "会中途断开的轮次");
    // 消费几个 op（确保已进入流、turn 已 start），然后在流中途断开
    for (let i = 0; i < 5; i++) {
      const r = await it.next();
      if (r.done) break;
    }
    expect(activeTurnList().some((t) => t.taskUri === uri)).toBe(true); // 断开前确实在跑

    // 消费端断开：这正是 http-server-binding 的 stream.on('close') → g.return() 做的事
    await it.return({ failed: false } as never);

    // ① ops.jsonl 里有本轮 turn 的 stop（否则重放会被当成"未完成/中断轮"）
    const fp = await opsFileOf(uri);
    expect(existsSync(fp)).toBe(true);
    const ops = readFileSync(fp, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { op: string; id: string; kind?: string });
    const turn = ops.find((o) => o.op === "start" && o.kind === "turn")!;
    expect(turn).toBeTruthy();
    expect(ops.some((o) => o.op === "stop" && o.id === turn.id)).toBe(true);
    // 活跃的 step 也收掉（否则它在块树里永远 streaming）
    const steps = ops.filter((o) => o.op === "start" && o.kind === "step");
    for (const st of steps) expect(ops.some((o) => o.op === "stop" && o.id === st.id)).toBe(true);

    // ② activeTurns 摘除（否则崩溃现场会挂一个根本不存在的轮次）
    expect(activeTurnList().some((t) => t.taskUri === uri)).toBe(false);

    // ③ turn-end 审计留痕（崩溃后能区分"死在生成中"还是"生成已结束"）
    expect(turnEndAuditCount(uri)).toBeGreaterThan(0);
  });

  it("断开时若队列还有插话：不出队、不落块（留待下一轮，绝不留成「两头都没有」）", async () => {
    const uri = newUri();
    new SteerQueue().add(uri, "next-step", "还没轮到投递就被断开了");
    const model = hangingModel();
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);

    const it = mgr.chat(uri, "会中途断开的轮次");
    for (let i = 0; i < 5; i++) {
      const r = await it.next();
      if (r.done) break;
    }
    await it.return({ failed: false } as never);

    // 本轮第一个请求走的是 stepNumber===0（不注入），插话既没投给模型也没落进 ops
    // → 它必须还在队列里（用户可以取消、下一轮会被投递）
    expect(new SteerQueue().list(uri).map((i) => i.text)).toEqual(["还没轮到投递就被断开了"]);
    const fp = await opsFileOf(uri);
    const ops = readFileSync(fp, "utf-8");
    expect(ops).not.toContain("还没轮到投递就被断开了");
  });
});

// ─── 插话的落位点：start-step，而不是 prepareStep ─────────
//
// 两条流不在同一时间轴上：认领发生在 SDK 内部的 prepareStep（同步回调），
// 而那一刻消费端**可能还压着上一步的 part**（producer 已跑到第 N+1 步，consumer 还在第 N 步尾部）。
// 若在 prepareStep 就 sink + 出队，插话块会插到上一步未完的内容**之前** ——
// 这在真实运行里出现过（ops.jsonl 里 su1 排在 stop s1 之前，见任务 169 review）。
//
// 判据选"第二个请求发出那一刻的现场"：prepareStep(step2) 已跑完（消息已注入）、
// step2 的首个 part（start-step）还没到。此刻新契约要求它**仍在队列里且未进 ops**（认领≠投递）。

describe("插话认领与落位分离（落位点 = start-step）", () => {
    it("step-2 请求发出时（prepareStep 已认领）：插话仍在队列、尚未落进 ops", async () => {
        const uri = newUri();
        const text = "等 start-step 才落位";
        new SteerQueue().add(uri, "next-step", text);
        /** 第二个请求发出那一刻的现场快照 */
        let atSecondRequest: { queued: number; opsHasBlock: boolean } | null = null;

        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub",
            doStream: () => {
                call++;
                if (call === 2) {
                    // 此刻：prepareStep(step2) 已跑完（插话文本已注入请求），但 step2 的 start-step 还没到
                    atSecondRequest = {
                        queued: new SteerQueue().list(uri).length,
                        opsHasBlock: opsRaw(uri).includes(text),
                    };
                }
                // step1 调工具（触发第二步）；step2 给答复
                return Promise.resolve(call === 1 ? toolCallReply("c1", "echo x") : textReply("完成"));
            },
        });

        const ops = await run(uri, "开始", model);

        // 认领时刻：队列仍在（未出队）、ops 里也没有（未落位）—— 这正是崩溃安全的来源
        expect(atSecondRequest).not.toBeNull();
        expect(atSecondRequest!.queued).toBe(1);
        expect(atSecondRequest!.opsHasBlock).toBe(false);

        // 收尾：start-step 到了 → 已落位（进 ops）并出队
        expect(new SteerQueue().list(uri)).toEqual([]);
        expect(opsRaw(uri)).toContain(text);

        // 结构不变式：插话块必须排在**第一个 step 的全部内容之后、第二个 step 开始之前**
        const flat = ops.map((o) => ({ op: o.op, kind: (o as { kind?: string }).kind, id: (o as { id: string }).id }));
        const steerIdx = flat.findIndex(
            (o) => o.op === "start" && o.kind === "text"
                && (ops[flat.indexOf(o)] as { meta?: { steer?: string } }).meta?.steer === "next-step",
        );
        const stepStarts = flat.map((o, i) => ({ ...o, i })).filter((o) => o.op === "start" && o.kind === "step");
        expect(stepStarts).toHaveLength(2);
        expect(steerIdx).toBeGreaterThan(stepStarts[0]!.i); // 不在第一步之前
        expect(steerIdx).toBeLessThan(stepStarts[1]!.i); // 在第二步之前
    });
});
