// tests/services/ops-feed.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##307 会话可见性（读侧）：op 增量订阅总线
//
// 契约（见 src/main/services/ops-feed.ts 头注）：
//   · seq = ops.jsonl 物理行号（append-only，故行数即水位）
//   · epoch 随 clear 换发（防旧 since 撞新文件）
//   · 订阅建流：hello（水位）→ 补发 (since, seq] → 实时
//
// 覆盖三层：
//   ① 纯水位/publish/reset 语义（不落盘，直接摆布总线）
//   ② 与 LocalAgentManager 的**写侧联动**：chat 产的 op 必须即时进订阅流（这就是
//      「别的窗口 / CLI 发起的轮次 UI 能看见」的机制本身）
//   ③ readOpLines 的边界：UTF-8 跨块、脏行、越界（都曾是把「读文件」写错的老坑）
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { opsFile } from "../../src/main/core/local-paths";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFeed, __test, type OpsFrame } from "../../src/main/services/ops-feed";
import type { Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key";
  PROJECT = createProject(join(diyHome(), "ops-feed-work"));
});

// 每个用例从空的内存缓存起步：`--no-isolate` 下 OpsFeed 单例跨文件共享，
// 而各文件自建数据根 ⇒ 同名 uri 的旧水位会串味（见 __test.resetFeeds 的注释）。
beforeEach(() => __test.resetFeeds());

let seq = 0;
const newUri = (): string => createTask({ title: `ops feed ${++seq}`, project: PROJECT });

/** 把 op 行写进该会话的 ops 文件（模拟 sink 的落盘） */
function writeOps(uri: string, ops: Op[]): void {
  const fp = opsFile(uri);
  mkdirSync(dirname(fp), { recursive: true });
  appendFileSync(fp, ops.map((o) => `${JSON.stringify(o)}\n`).join(""), "utf-8");
}

/** 收集订阅流的前 n 帧（超时兜底，避免用例挂死） */
async function collect(stream: AsyncIterable<OpsFrame>, n: number, timeoutMs = 1500): Promise<OpsFrame[]> {
  const out: OpsFrame[] = [];
  const it = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (out.length < n && Date.now() < deadline) {
    const r = await Promise.race([
      it.next(),
      new Promise<IteratorResult<OpsFrame>>((res) => setTimeout(() => res({ value: undefined as never, done: true }), 50)),
    ]);
    if (r.done) continue; // 超时占位：继续轮询（下游可能稍后才推）
    out.push(r.value);
  }
  return out;
}

// ─── ① 水位 / publish / reset ────────────────────────────

describe("opsFeed — 水位与增量", () => {
  it("水位从盘上现有内容起步；publish 按行号推进，帧带 fromSeq", () => {
    const uri = newUri();
    const a: Op = { op: "start", id: "t1", kind: "turn" };
    writeOps(uri, [a]); // 会话已有 1 行（模拟「CLI 早先写过」）

    expect(opsFeed.watermark(uri)).toEqual({ epoch: 0, seq: 1 });

    // 订阅在 publish 之前 → 首帧 hello 报告水位，随后 publish 推 batch
    const sub = opsFeed.subscribe(uri, 1);
    const frames: OpsFrame[] = [];
    void (async () => {
      for await (const f of sub) frames.push(f);
    })();

    const b: Op = { op: "stop", id: "t1" };
    writeOps(uri, [b]);
    opsFeed.publish(uri, [b]);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(frames[0]).toEqual({ kind: "hello", epoch: 0, seq: 1 });
        const batch = frames.find((f) => f.kind === "batch") as Extract<OpsFrame, { kind: "batch" }>;
        expect(batch.fromSeq).toBe(2);
        expect(batch.ops).toEqual([b]);
        expect(opsFeed.watermark(uri)).toEqual({ epoch: 0, seq: 2 });
        resolve();
      }, 60);
    });
  });

  it("补发：订阅 since 落后于水位时，把 (since, seq] 一次补齐", async () => {
    const uri = newUri();
    const ops: Op[] = [
      { op: "start", id: "t1", kind: "turn" },
      { op: "stop", id: "t1" },
      { op: "start", id: "t2", kind: "turn" },
    ];
    writeOps(uri, ops);

    const frames = await collect(opsFeed.subscribe(uri, 1), 2);
    expect(frames[0]).toEqual({ kind: "hello", epoch: 0, seq: 3 });
    const batch = frames[1] as Extract<OpsFrame, { kind: "batch" }>;
    expect(batch.fromSeq).toBe(2);
    expect(batch.ops).toEqual(ops.slice(1));
  });

  it("reset：epoch 换发、水位归零，并推 reset 帧", async () => {
    const uri = newUri();
    writeOps(uri, [{ op: "start", id: "t1", kind: "turn" }]);
    expect(opsFeed.watermark(uri).seq).toBe(1);

    const frames: OpsFrame[] = [];
    void (async () => {
      for await (const f of opsFeed.subscribe(uri, 1)) frames.push(f);
    })();
    // 等 hello 落地再 reset
    await new Promise((r) => setTimeout(r, 30));
    opsFeed.reset(uri);
    await new Promise((r) => setTimeout(r, 30));

    expect(opsFeed.watermark(uri)).toEqual({ epoch: 1, seq: 0 });
    expect(frames.some((f) => f.kind === "reset" && f.epoch === 1)).toBe(true);
  });

  it("epoch 不符：订阅方持旧代次 → 首帧后补发 reset（订阅方据此重建）", async () => {
    const uri = newUri();
    opsFeed.reset(uri); // epoch → 1
    const frames = await collect(opsFeed.subscribe(uri, 0, 0), 2);
    expect(frames[0]).toMatchObject({ kind: "hello", epoch: 1 });
    expect(frames[1]).toEqual({ kind: "reset", epoch: 1 });
  });

  it("首次 publish 建 feed：水位 == 真实行数（sink 先落盘再 publish，基线不许 +1）", () => {
    // 回归 review2 R1：本进程内该 task 从未 watermark/subscribe/reset（UI 没开过它），
    // CLI / 后台先落第一个 op → feed 在 publish 时才建立，而此刻 countLines 已含刚写的那行。
    const uri = newUri();
    const a: Op = { op: "start", id: "t1", kind: "turn" };
    const b: Op = { op: "stop", id: "t1" };
    writeOps(uri, [a]); // 盘上 1 行，feed 未触碰
    writeOps(uri, [b]); // sink 时序：先落盘（盘上 2 行）
    opsFeed.publish(uri, [b]); //             再 publish（b 是第 2 行）
    expect(opsFeed.watermark(uri).seq).toBe(2); // 曾是 3（基线多算 → 水位全体 +1）
  });

  it("断线期间写入的 op，重连补发不丢（基线偏移曾吞掉断线期间的首条）", async () => {
    // 回归 review2 R1 的后果面：坐标错位 1 会让 readOpLines(since+1, seq) 少读一条。
    const uri = newUri();
    const op1: Op = { op: "start", id: "t1", kind: "turn" };
    const op2: Op = { op: "start", id: "t2", kind: "turn" };
    const op3: Op = { op: "stop", id: "t1" };
    writeOps(uri, [op1]);
    opsFeed.publish(uri, [op1]); // 首建 feed（同上一用例的路径）
    const wm = opsFeed.watermark(uri);
    expect(wm.seq).toBe(1);

    await collect(opsFeed.subscribe(uri, wm.seq, wm.epoch), 1); // 首订拿 hello 即断线
    writeOps(uri, [op2]);
    opsFeed.publish(uri, [op2]); // 断线期间（真实行 2、3）
    writeOps(uri, [op3]);
    opsFeed.publish(uri, [op3]);

    const frames = await collect(opsFeed.subscribe(uri, wm.seq, wm.epoch), 2); // 重连
    const batch = frames.find((f): f is Extract<OpsFrame, { kind: "batch" }> => f.kind === "batch");
    expect(batch?.ops).toEqual([op2, op3]); // 曾只回 [op3]（op2 被吞）
  });

  it("退订：订阅取消后不再收帧（防内存/事件泄漏）", async () => {
    const uri = newUri();
    const sub = opsFeed.subscribe(uri, 0);
    const it = sub[Symbol.asyncIterator]();
    await it.next(); // hello
    await it.return?.({ value: undefined, done: true });
    opsFeed.publish(uri, [{ op: "start", id: "t1", kind: "turn" }]);
    // 退订后 publish 不应抛错，且水位照常推进（广播只是没人收）
    expect(opsFeed.watermark(uri).seq).toBe(1);
  });

  it("断连（signal abort）即时退订：无 op 期间 subscriberCount 立刻归零，不必等下一条 op", () => {
    // 回归：RPC 传输断开调的是 abort + void g.return()，而 return 排在悬挂的 next() 之后
    // （无 op 时生成器卡在 await next 上）→ 订阅曾滞留到**下一条 op** 才释放，
    // `agent.local.running.subscribers`（[5] ##308「有没有人在看」）随之虚高。
    const uri = newUri();
    const ctrl = new AbortController();
    const sub = opsFeed.subscribe(uri, 0, undefined, ctrl.signal);
    const it = sub[Symbol.asyncIterator]();
    return it.next().then(() => {
      expect(opsFeed.subscriberCount(uri)).toBe(1);
      ctrl.abort(); // 复刻 stream.on('close') 的 abort（此后不会有任何 op 流入）
      expect(opsFeed.subscriberCount(uri)).toBe(0); // 曾要等到下一条 op 才归零
    });
  });

  it("订阅后连接正常关闭（return）同样退订，且与 abort 不双重清理", async () => {
    const uri = newUri();
    const ctrl = new AbortController();
    const sub = opsFeed.subscribe(uri, 0, undefined, ctrl.signal);
    const it = sub[Symbol.asyncIterator]();
    await it.next(); // hello
    await it.return?.({ value: undefined, done: true });
    expect(opsFeed.subscriberCount(uri)).toBe(0);
    ctrl.abort(); // 迟到的 abort 不应二次 cleanup（计数不会变负/抛错）
    expect(opsFeed.subscriberCount(uri)).toBe(0);
  });

  it("多订阅者广播：两个订阅者（N 窗口 = N 订阅者）收到同一批，非单播", async () => {
    const uri = newUri();
    const a: Op = { op: "start", id: "t1", kind: "turn" };
    writeOps(uri, [a]); // 水位 1

    // 两个独立订阅者，都从水位 1 起（= 两个窗口同时看同一 task）
    const f1: OpsFrame[] = [];
    const f2: OpsFrame[] = [];
    void (async () => { for await (const f of opsFeed.subscribe(uri, 1)) f1.push(f); })();
    void (async () => { for await (const f of opsFeed.subscribe(uri, 1)) f2.push(f); })();
    await new Promise((r) => setTimeout(r, 30)); // 两订阅先建流

    const b: Op = { op: "stop", id: "t1" };
    writeOps(uri, [b]);
    opsFeed.publish(uri, [b]);
    await new Promise((r) => setTimeout(r, 30));

    const b1 = f1.find((f): f is Extract<OpsFrame, { kind: "batch" }> => f.kind === "batch");
    const b2 = f2.find((f): f is Extract<OpsFrame, { kind: "batch" }> => f.kind === "batch");
    expect(b1?.fromSeq).toBe(2);
    expect(b2?.fromSeq).toBe(2);
    expect(b1?.ops).toEqual([b]);
    expect(b2?.ops).toEqual(b1?.ops); // 两个窗口看到的内容逐字一致
  });
});

// ─── ② 与 LocalAgentManager 写侧联动 ─────────────────────

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textModel(text: string): MockLanguageModelV3 {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
  const stream: LanguageModelV3StreamResult = {
    stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }),
  };
  return new MockLanguageModelV3({ provider: "stub", modelId: "stub", doStream: () => Promise.resolve(stream) });
}

describe("opsFeed — 与 local-agent 写侧联动", () => {
  it("chat 产的 op 即时进订阅流，且与盘上日志逐条一致（这就是「别人跑的轮次 UI 也看得见」）", async () => {
    const uri = newUri();
    const model = textModel("你好，这是答复");
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);

    const frames: OpsFrame[] = [];
    const sub = opsFeed.subscribe(uri, 0);
    const it = sub[Symbol.asyncIterator]();
    // 订阅流不会自然结束（实时通道），故用后台泵 + 结束时显式退订，避免挂死用例
    const pump = (async () => {
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        frames.push(r.value);
      }
    })();

    for await (const op of mgr.chat(uri, "问一句")) void op; // 消费到结束
    await new Promise((r) => setTimeout(r, 80));

    const streamed = frames
      .filter((f): f is Extract<OpsFrame, { kind: "batch" }> => f.kind === "batch")
      .flatMap((f) => f.ops);
    const onDisk = JSON.parse(`[${readDisk(uri)}]`) as Op[];
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed).toEqual(onDisk); // 广播的 = 盘上的（同一落盘点，不多不少不重）

    await it.return?.({ value: undefined, done: true });
    await pump;
  });
});

/** 盘上 op 行 → JSON 数组文本（跳过空行；用于与广播内容逐条比对） */
function readDisk(uri: string): string {
  return readFileSync(opsFile(uri), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join(",");
}

// ─── ③ readOpLines 边界 ─────────────────────────────────

describe("readOpLines — 边界", () => {
  it("UTF-8 跨块不破行（中文/emoji 恰好压在块边界上）", () => {
    const uri = newUri();
    const fp = opsFile(uri);
    mkdirSync(dirname(fp), { recursive: true });
    // 让第二行起点落在 256KB 块边界附近：首行填充到边界前 1 字节
    const filler = "a".repeat(256 * 1024 - 1);
    const zh: Op = { op: "delta", id: "t1", fields: { text: "中文内容🙂——跨块边界" } };
    writeFileSync(fp, `${filler}\n${JSON.stringify(zh)}\n`, "utf-8");

    // 关键断言：第二行（中文 + emoji，跨 256KB 块边界）必须完整解析 —— 裸 toString 会撕裂多字节字符
    expect(__test.readOpLines(fp, 2, 2)).toEqual([zh]);
    expect(__test.readOpLines(fp, 1, 1)).toEqual([]); // 首行是填充串（非 JSON）→ 跳过
    expect(__test.countLines(fp)).toBe(2);
  });

  it("脏行跳过、越界返回空，且不影响其它行", () => {
    const uri = newUri();
    const fp = opsFile(uri);
    mkdirSync(dirname(fp), { recursive: true });
    const a: Op = { op: "start", id: "t1", kind: "turn" };
    const b: Op = { op: "stop", id: "t1" };
    writeFileSync(fp, `${JSON.stringify(a)}\n{坏行\n${JSON.stringify(b)}\n`, "utf-8");

    const got = __test.readOpLines(fp, 1, 3);
    expect(got).toEqual([a, b]); // 脏行被跳过，其余不动
    expect(__test.readOpLines(fp, 9, 12)).toEqual([]);
  });
});
