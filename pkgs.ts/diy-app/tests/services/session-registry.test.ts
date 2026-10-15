// tests/services/session-registry.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##240 会话/轮次注册表内核 + 注册表订阅帧
//
// 契约（见 src/main/services/session-registry.ts 与 shared/registry-frame.ts 头注）：
//   · 语义 = 「本次 main 进程启动后活跃过的会话」（纯内存，启动即空）
//   · R5：轮次结束**只清 turn、条目保留**（turnCount / lastEndReason 是可读证据）
//   · R3：注册表自身的订阅者**不计入 viewers**（viewers 只由内容订阅者构成）
//   · 读侧：首帧 snapshot（全量）+ upsert（单条变更）；`watch=false` 只给一份快照
//
// 反证用例（派活明确要求）：
//   · R3 —— 开注册表观察者后 `viewers` 不虚增
//   · R5 —— 轮次结束后条目仍在（idle）、turnCount +1、lastEndReason 可见
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { sessionRegistry } from "../../src/main/services/session-registry";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFeed } from "../../src/main/services/ops-feed";
import type { RegistryFrame } from "../../src/shared/registry-frame";

let PROJECT = "";
beforeEach(() => {
  PROJECT = createProject(join(diyHome(), `sess-reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  sessionRegistry.reset();
});

let n = 0;
const newUri = (): string => createTask({ title: `sess reg ${++n}`, project: PROJECT });

/** 收订阅流的前 n 帧（超时兜底；返回 done 标志便于断言"流已结束"） */
async function collect(
  stream: AsyncIterable<RegistryFrame>,
  count: number,
  timeoutMs = 1000,
): Promise<{ frames: RegistryFrame[]; done: boolean }> {
  const frames: RegistryFrame[] = [];
  const it = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([
      it.next(),
      new Promise<IteratorResult<RegistryFrame>>((res) =>
        setTimeout(() => res({ value: undefined as never, done: false }), 30),
      ),
    ]);
    if (r.done) return { frames, done: true };
    if (r.value !== undefined) frames.push(r.value);
    if (frames.length >= count) return { frames, done: false };
  }
  return { frames, done: false };
}

describe("sessionRegistry — 快照 / 增量", () => {
  it("首帧永远是全量快照；round 未跑时 turn=null", async () => {
    const uri = newUri();
    sessionRegistry.noteActivity(uri); // 一次活动（如留言）即建档

    const { frames } = await collect(sessionRegistry.subscribe({}), 1);
    const snap = frames[0] as Extract<RegistryFrame, { kind: "snapshot" }>;
    expect(snap.kind).toBe("snapshot");
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]!.refs).toEqual([{ kind: "task", uri }]);
    expect(snap.entries[0]!.turn).toBe(null);
    expect(snap.entries[0]!.turnCount).toBe(0);
    expect(snap.entries[0]!.id).toMatch(/^local-/);
  });

  it("watch=false：只给一份快照就结束（CLI 无参路径）", async () => {
    const uri = newUri();
    sessionRegistry.noteTurnStart(uri, { turnId: "t1" });

    const { frames, done } = await collect(sessionRegistry.subscribe({ watch: false }), 2);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe("snapshot");
    expect(done).toBe(true); // 流已闭合
    expect(sessionRegistry.subscriberCount()).toBe(0); // 未订阅（也就没占用 viewers）
  });

  it("watch=true：轮次推进逐条推 upsert（steps 变化一行内可见）", async () => {
    const uri = newUri();
    const sub = sessionRegistry.subscribe({ watch: true });
    const seen: RegistryFrame[] = [];
    const it = sub[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const r = await it.next();
        if (r.done) return;
        seen.push(r.value);
      }
    })();

    sessionRegistry.noteTurnStart(uri, { turnId: "t1" });
    sessionRegistry.noteTurnStep(uri, 1);
    sessionRegistry.noteTurnStep(uri, 2);

    await new Promise((r) => setTimeout(r, 60));
    const upserts = seen.filter((f) => f.kind === "upsert") as Extract<RegistryFrame, { kind: "upsert" }>[];
    expect(upserts.length).toBeGreaterThanOrEqual(3);
    expect(upserts.at(-1)!.entry.turn!.steps).toBe(2);
    expect(upserts.at(-1)!.entry.turn!.state).toBe("detached"); // 无内容订阅者 → detached
    await it.return?.();
  });

  it("R5 反证：轮次结束后条目仍在（idle）、turnCount +1、lastEndReason 可见、累计 steps/tokens", async () => {
    const uri = newUri();
    sessionRegistry.noteTurnStart(uri, { turnId: "t1" });
    sessionRegistry.noteTurnStep(uri, 3);
    sessionRegistry.noteTurnUsage(uri, 120);
    // 快照里此刻是在途轮次
    expect(sessionRegistry.snapshot()[0]!.turn!.steps).toBe(3);
    expect(sessionRegistry.snapshot()[0]!.turn!.tokens).toBe(120);

    sessionRegistry.noteTurnEnd(uri, { type: "completed", data: {} }, { steps: 3, tokens: 120 });

    const e = sessionRegistry.snapshot()[0]!;
    expect(e.turn).toBe(null); // 只清 turn
    expect(e.turnCount).toBe(1); // 条目仍在 + 计数
    expect(e.lastEndReason).toEqual({ type: "completed", data: {} });
    expect(e.totalSteps).toBe(3); // 进程内累计保留
    expect(e.totalTokens).toBe(120);
  });

  it("R5 幂等：收口后再调 noteTurnEnd（driveTurn 兜底路径）不重复计数、不覆盖末轮原因", () => {
    const uri = newUri();
    sessionRegistry.noteTurnStart(uri, { turnId: "t1" });
    sessionRegistry.noteTurnEnd(uri, { type: "max-steps", data: { steps: 200, limit: 200 } }, { steps: 200, tokens: 5 });
    sessionRegistry.noteTurnEnd(uri, { type: "aborted", data: { source: "detached" } }); // 兜底重入

    const e = sessionRegistry.snapshot()[0]!;
    expect(e.turnCount).toBe(1);
    expect(e.lastEndReason).toEqual({ type: "max-steps", data: { steps: 200, limit: 200 } });
    expect(e.totalSteps).toBe(200);
  });

  it("R3 反证：开注册表观察者后 viewers 不虚增（注册表订阅者不计入）", async () => {
    const uri = newUri();
    // 真 manager：注册表的活态取值器指向它（ViewersOf = chat subs + op 流订阅者）
    const agent = new LocalAgentManager();
    sessionRegistry.noteTurnStart(uri, { turnId: "t1" });

    // 一个**内容**订阅者（op 流）→ viewers 应计 1
    const opSub = opsFeed.subscribe(uri, 0);
    const opIt = opSub[Symbol.asyncIterator]();
    void opIt.next();
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.watchers(uri)).toBe(1);
    expect(sessionRegistry.snapshot()[0]!.viewers).toBe(1);

    // 再加一个**注册表**观察者 → viewers 必须**仍是 1**，订阅者数另计
    const regIt = sessionRegistry.subscribe({ watch: true })[Symbol.asyncIterator]();
    void regIt.next();
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionRegistry.subscriberCount()).toBe(1);
    expect(sessionRegistry.snapshot()[0]!.viewers).toBe(1); // ← 反证点：不虚增

    await regIt.return?.();
    await opIt.return?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionRegistry.snapshot()[0]!.viewers).toBe(0);
  });
});

describe("LocalAgentManager.setLimits — 写盘 + 失效缓存", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["DIY_LOCAL_MAX_STEPS", "DIY_LOCAL_MAX_STEER_QUEUE"]) {
      saved[k] = process.env[k];
      delete process.env[k]; // 环境变量优先级最高，会让写入值"不生效"而误判
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("写入后立即生效（无需重启）：缓存被失效，getLimits 反映新值", () => {
    const agent = new LocalAgentManager();
    expect(agent.getLimits().maxSteps).toBe(200); // 缺省（首次读入并缓存）
    const after = agent.setLimits({ maxSteps: 123 });
    expect(after.maxSteps).toBe(123);
    expect(agent.getLimits().maxSteps).toBe(123); // ← 若不失效缓存这里仍是 200
  });

  it("非法值忽略（不写坏文件）：0 / 负数 / NaN 一律不落盘", () => {
    const agent = new LocalAgentManager();
    agent.setLimits({ maxSteps: 150 });
    const after = agent.setLimits({ maxSteps: 0, maxSteerQueue: Number.NaN });
    expect(after.maxSteps).toBe(150);
    expect(after.maxSteerQueue).toBe(1000); // 仍是缺省
  });
});
