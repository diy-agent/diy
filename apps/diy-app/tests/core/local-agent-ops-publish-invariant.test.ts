// tests/core/local-agent-ops-publish-invariant.test.ts
// 🎯 ##327 review1 R2 的核心不变量：**chat 流 yield 的 op ⊆ 已 publish 的 op**。
//
// 为什么要有人守它：##327 起 renderer 侧把 chat 流的 op **一个都不落地**（只当"本轮结束/
// 报错"信号），实时显示 100% 走 opsWatch 增量订阅 —— 而订阅的唯一入口是 main 的
// `opsFeed.publish`。于是"yield 了却没 publish"的 op 在 UI 上**永久不可见**（旧实现由
// chat 流 side 兜住）。这条在代码上成立（chat 的驱动循环一律 `sink` 再 `yield`，
// `sink` = appendFileSync + publish），但此前**没有测试**。
//
// 唯一已知分叉：`sink` 落盘失败（local-agent.opsSink 的 catch）**不 publish 但照旧 yield**。
// 那是**自洽**的而非缺陷 —— 盘上没有的东西重载后本来也会丢，显示它反而是假象
//（与「wire = 存储 = 渲染输入」同一取向）。第二种用例把这条也钉下来。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFeed } from "../../src/main/services/ops-feed";
import { opsFile } from "../../src/main/core/local-paths";
import type { Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
  PROJECT = createProject(join(diyHome(), "ops-publish-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `publish 不变量 ${++seq}`, project: PROJECT });

// ─── 桩模型（与 local-agent-ops-atomic.test.ts 同一套写法）────────────────

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** 一段纯文本答复 + 一个工具步，尽量让一轮里 op 种类齐一点（turn/text/stop） */
const textReply = (text: string): LanguageModelV3StreamResult => ({
  stream: new ReadableStream<LanguageModelV3StreamPart>({
    start(c) {
      for (const p of [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ] as LanguageModelV3StreamPart[]) {
        c.enqueue(p);
      }
      c.close();
    },
  }),
});

// ─── 收 publish：真的订阅一次 opsFeed（不是替换实现 —— 要连 publish→帧 那段一起验）──

interface Published {
  /** 至今收到的 op（按帧序拼起来） */
  ops: () => Op[];
  stop: () => void;
}

function watchPublish(uri: string): Published {
  const got: Op[] = [];
  let done = false;
  const iter = opsFeed.subscribe(uri, 0)[Symbol.asyncIterator]();
  void (async () => {
    try {
      while (!done) {
        const r = await iter.next();
        if (r.done) break;
        if (r.value.kind === "batch") got.push(...r.value.ops);
      }
    } catch {
      /* 收工时的正常中断 */
    }
  })();
  return { ops: () => got, stop: () => { done = true; void iter.return?.(); } };
}

async function runTurn(uri: string, message: string, text: string): Promise<Op[]> {
  const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: "stub-model",
    doStream: () => Promise.resolve(textReply(text)),
  });
  const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
  const yielded: Op[] = [];
  for await (const op of mgr.chat(uri, message)) yielded.push(op);
  return yielded;
}

const watchers: Published[] = [];
afterEach(() => {
  for (const w of watchers) w.stop();
  watchers.length = 0;
});

describe("chat 流 yield 的 op ⊆ 已 publish 的 op", () => {
  it("正常一轮：每条 yield 出去的 op 都能在 publish 集合里找到（UI 的通道不漏东西）", async () => {
    const uri = newUri();
    const w = watchPublish(uri);
    watchers.push(w);

    const yielded = await runTurn(uri, "走一轮", "看现场");
    // 让 publish 帧走完（同一条连接上的推送是同步 push，这里只是给微任务一个机会）
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

    const published = w.ops();
    expect(yielded.length).toBeGreaterThan(0);
    expect(published.length).toBeGreaterThan(0);
    // 逐条比对：yield 的每一条都必须已被 publish（顺序也一致 —— 均按写作序）
    const missing = yielded.filter((op) => !published.some((p) => JSON.stringify(p) === JSON.stringify(op)));
    expect(missing).toEqual([]);
    expect(published.length).toBe(yielded.length);
    expect(published.map((o) => o.op)).toEqual(yielded.map((o) => o.op));
  });

  it("落盘失败（不 publish 但照旧 yield）：UI 看不见它是**自洽**的 —— 盘上也没有", async () => {
    const uri = newUri();
    const w = watchPublish(uri); // 先订阅（此时 ops 文件还不存在，订阅能建起来）
    watchers.push(w);

    // 只读的 ops.jsonl：appendFileSync 必 EACCES（sink 的失败分支）；读侧不受影响。
    // 不用"占位成目录"那招 —— 那会先把 getSession 的 readJsonl 一起弄崩，验不到 sink。
    const fp = opsFile(uri);
    writeFileSync(fp, "");
    chmodSync(fp, 0o400);

    let yielded: Op[] = [];
    try {
      yielded = await runTurn(uri, "落盘必失败的一轮", "看现场");
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    } finally {
      chmodSync(fp, 0o600); // 还原，否则临时 HOME 删不掉
    }

    expect(yielded.length).toBeGreaterThan(0); // 流照旧往下走（不阻断用户）
    expect(w.ops()).toEqual([]); // 但一条也没 broadcast —— 订阅侧（= UI 的唯一通道）看不见
    // 关键：盘上**也没有**（文件仍是空的）⇒ 重载同样拿不到它，
    // 所以"UI 看不见"与"存储里没有"是同一个事实的两面，不是漏显示。
    expect(readFileSync(fp, "utf-8").trim()).toBe("");
  });
});
