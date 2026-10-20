// tests/core/room-busy-steer.test.ts
// 🎯 忙时投递的**送达判据**（##377 第 27 刀 · review1 R1）
//
// 病灶（owner 定位，我核过代码）：`ok + note「已插入正在跑的轮次」` 在**未验证送达**时就落地。
// 插话被取走只有两个时机 —— **下一步之前**（`claimStepSteers`）与**轮末续轮的开场**
// （`chat()` 的续轮循环）。轮次恰好在收尾时这两个都不会再发生 ⇒ 那条话留在 `drafts.yaml`，
// 而房间页已经说了「已投递」。
//
// 判据（本次修法钉死的那一句）：**`ok` = 入队 且（仍在跑 或 已唤醒）**。
//
// 反证的形状：把 `busy` 探针钉成恒 `true`（= 修前"入队即报 ok"的行为）⇒ 队列里那条
// **一条 op 都不会产出**（`prompts` 空、`steerList` 仍 1 条）—— 这就是那句假话的实体。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { steerOrWake, type RunResult } from "../../src/main/services/room-service";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "busy-steer-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `忙时投递 ${++seq}`, project: PROJECT });

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

/** 桩模型：把每次真发的 prompt 记下来（判据 = 这条话有没有真的进模型输入） */
function stubModel(prompts: unknown[]): LanguageModel {
  return new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: (options) => {
      prompts.push(options.prompt);
      return Promise.resolve(textReply("收到"));
    },
  }) as unknown as LanguageModel;
}

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

/** 真实依赖：入队 / 复判 / 唤醒都走 `LocalAgentManager` 本体，只有 `busy` 是脚本化的探针 */
function realDeps(mgr: LocalAgentManager, busyScript: boolean[]) {
  let i = 0;
  return {
    steerAdd: (taskUri: string, mode: "next-step" | "next-turn", text: string, author?: string) => {
      mgr.steerAdd(taskUri, mode, text, author);
    },
    busy: (): boolean => busyScript[Math.min(i++, busyScript.length - 1)]!,
    runQueued: async (taskUri: string): Promise<RunResult> => {
      // 与生产同一条路：`chatQueued`（用队列现有内容开一轮）—— 但 collectTurn 在模块内，
      // 测试直接驱动同一个生成器并把结果按同一判据收成 RunResult。
      const texts = new Map<string, string>();
      const errs: string[] = [];
      let turnId: string | undefined;
      try {
        for await (const op of mgr.chatQueued(taskUri)) {
          if (op.op === "start") {
            if (op.kind === "turn") turnId = op.id;
            if (op.kind === "text" && op.meta?.["role"] !== "user") texts.set(op.id, "");
            if (op.kind === "error") errs.push("");
          } else if (op.op === "delta") {
            const c = op.fields["content"];
            if (typeof c === "string" && texts.has(op.id)) texts.set(op.id, texts.get(op.id)! + c);
          }
        }
      } catch (e) {
        return { reply: "", error: `投递失败：${String(e)}` };
      }
      const reply = [...texts.values()].join("\n").trim();
      return {
        reply,
        ...(reply ? {} : { error: errs.length > 0 ? "对方会话报错" : "对方这一轮没有产出文本" }),
        ...(turnId ? { turnId } : {}),
      };
    },
  };
}

describe("忙时投递：入队后复判（`ok` = 入队 且（仍在跑 或 已唤醒））", () => {
  it("① 轮次仍在跑 ⇒ 插进那一轮（不另开轮，话在队列里等下一步 / 轮末续轮认领）", async () => {
    const uri = newUri();
    const prompts: unknown[] = [];
    const mgr = new LocalAgentManager(() => stubModel(prompts));
    const r = await steerOrWake(uri, "[多人房间 x] ccc 对你说：\n这句话", "human:ccc", realDeps(mgr, [true]));

    expect(r.kind).toBe("steer");
    expect(mgr.steerList(uri).map((it) => it.text)).toEqual(["[多人房间 x] ccc 对你说：\n这句话"]);
    expect(prompts.length).toBe(0); // 没开轮 —— 认领点不在这里
  });

  it("② **轮次恰好在收尾**（复判时已不忙）⇒ 用队列内容醒来一轮，这条话真被送出", async () => {
    const uri = newUri();
    const prompts: unknown[] = [];
    const mgr = new LocalAgentManager(() => stubModel(prompts));
    // 探针只脚本化**复判**那一次（计划那次在 `deliverOne`，本测试不经过它）：false = 已收尾
    const r = await steerOrWake(uri, "[多人房间 x] ccc 对你说：\n最后一句话", "human:ccc", realDeps(mgr, [false]));

    expect(r.kind).toBe("wake");
    expect(r.kind === "wake" ? r.r.reply : "").toBe("收到");
    expect(r.kind === "wake" ? Boolean(r.r.turnId) : false).toBe(true);
    // 判据取在**模型真收到的那份输入**上：这条话进了开场 user 块
    expect(flatten(prompts.at(-1))).toContain("最后一句话");
    // 队列被取走（不是"还躺在 drafts.yaml 里"）
    expect(mgr.steerList(uri)).toEqual([]);
  });

  it("③ 复判后开轮失败 + 又忙起来（竞态）⇒ 仍算 steer，不谎报「投递失败」", async () => {
    const uri = newUri();
    const busted: RunResult = { reply: "", error: "投递失败：会话正忙" };
    let i = 0;
    const r = await steerOrWake(uri, "这句话", "human:ccc", {
      steerAdd: () => undefined,
      busy: () => [false, true][i++] ?? true, // ①复判闲 ②开轮失败后再判：又忙了
      runQueued: async () => busted,
    });
    expect(r.kind).toBe("steer"); // 话安好在队列里，由那一轮带走
  });

  it("④ **反证**：修前的形状（只入队、不复判）⇒ 同一个场景这条话一条 op 都不产出", async () => {
    // 与 ② **同一个场景**（复判那一刻轮次已收尾），只把"复判 + 唤醒"这半步去掉 ——
    // 这就是修前的代码在房间页说「已投递」时那条话的真实归宿。
    const uri = newUri();
    const prompts: unknown[] = [];
    const mgr = new LocalAgentManager(() => stubModel(prompts));
    mgr.steerAdd(uri, "next-step", "[多人房间 x] ccc 对你说：\n没人取的留言", "human:ccc");

    expect(mgr.steerList(uri).map((it) => it.text)).toEqual(["[多人房间 x] ccc 对你说：\n没人取的留言"]);
    expect(prompts.length).toBe(0);
  });
});
