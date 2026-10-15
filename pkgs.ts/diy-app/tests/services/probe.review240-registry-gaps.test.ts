// tests/services/probe.review240-registry-gaps.test.ts
// ═══════════════════════════════════════════════════════════════
// ##240 review1 探针（临时文件；缺口定责并修复后**销毁或并入** session-registry.test.ts）
//
// 目的：实证三处「注册表事实的可见性缺口」——
//   A 仅被"打开"（内容订阅）而从未跑过轮次的会话**不入册** → [5] 总览看不见"有人看"的会话
//   B `viewers` 变化（内容订阅者增/退）**不推帧** → --watch 订阅方看到的 viewers/state 陈旧
//   C `viewersOf/queueOf` 依赖 LocalAgentManager **实例化时机**（未构造则恒 0）
// 三者同源：注册表的活态属性没有「变化即 touch」的写点（ops-feed 订阅/退订处缺一次 noteActivity）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { sessionRegistry } from "../../src/main/services/session-registry";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFeed } from "../../src/main/services/ops-feed";
import type { RegistryFrame } from "../../src/shared/registry-frame";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let PROJECT = "";
let n = 0;
beforeEach(() => {
  PROJECT = createProject(join(diyHome(), `probe240-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  sessionRegistry.reset();
});
const newUri = (): string => createTask({ title: `probe240 ${++n}`, project: PROJECT });

describe("探针 A — 只被打开、未跑轮次的会话", () => {
  it("有内容观察者（viewers=1）时，注册表里仍无该条目", async () => {
    const agent = new LocalAgentManager(); // 走生产 deps 注入路径
    const uri = newUri();
    const opIt = opsFeed.subscribe(uri, 0)[Symbol.asyncIterator]();
    void opIt.next();
    await wait(20);

    expect(agent.watchers(uri)).toBe(1); // 确实有 1 个内容观察者
    const snap = sessionRegistry.snapshot();
    console.log("PROBE-A entries=", JSON.stringify(snap.map((e) => ({ id: e.id, viewers: e.viewers }))));
    expect(snap).toHaveLength(0); // ← 缺口：不入册（[5] 的「打开·未通讯」格无处可显示）
    await opIt.return?.();
  });
});

describe("探针 B — viewers 变化不推帧", () => {
  it("内容订阅者退订后，--watch 订阅方收不到任何帧（viewers 陈旧）", async () => {
    const uri = newUri();
    sessionRegistry.noteTurnStart(uri, { turnId: "t1" }); // 先建档（有轮次才会入册）
    const frames: RegistryFrame[] = [];
    const it = sessionRegistry.subscribe({ watch: true })[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const r = await it.next();
        if (r.done) return;
        frames.push(r.value);
      }
    })();
    await wait(20);
    frames.length = 0; // 丢弃首帧 snapshot，只看增量

    const agent = new LocalAgentManager();
    const opIt = opsFeed.subscribe(uri, 0)[Symbol.asyncIterator]();
    void opIt.next();
    await wait(30);
    expect(agent.watchers(uri)).toBe(1);
    await opIt.return?.();

    await wait(60);
    console.log(
      "PROBE-B 退订后增量帧数=", frames.length,
      "snapshot.viewers=", sessionRegistry.snapshot()[0]!.viewers,
      "snapshot.turn.state=", sessionRegistry.snapshot()[0]!.turn?.state,
    );
    expect(frames).toHaveLength(0); // ← 缺口：订阅方看不到 viewers 归零 / state 翻 detached
    expect(sessionRegistry.snapshot()[0]!.viewers).toBe(0); // 只有重新快照才对
    await it.return?.();
  });
});

describe("探针 C — deps 依赖 manager 实例化时机", () => {
  it("manager 未构造时（deps 默认）viewers 恒 0，尽管 opsFeed 已有订阅者", async () => {
    const uri = newUri();
    const opIt = opsFeed.subscribe(uri, 0)[Symbol.asyncIterator]();
    void opIt.next();
    await wait(20);

    sessionRegistry.noteTurnStart(uri, { turnId: "t1" });
    const e = sessionRegistry.snapshot()[0]!;
    console.log("PROBE-C viewers=", e.viewers, "opsFeed.subscriberCount=", opsFeed.subscriberCount(uri));
    expect(opsFeed.subscriberCount(uri)).toBe(1);
    expect(e.viewers).toBe(0); // ← 脆弱性：真观察者数 1 被报成 0
    await opIt.return?.();
  });
});
