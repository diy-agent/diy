// tests/core/room-steer-turn.test.ts
// 🎯 忙时插话的**回复归属**（##377 第 29 刀 · body 真缺陷第 1 条）
//
// 病灶：忙时插话的回复属于**正在跑的那一轮**（`deliveryPlanFor` 的 `steer` 分支）⇒ room 里
// 只有 `say`、没有 `reply`。用户能看到的证据只有「已投递（插进本轮）」徽章，**看不出回复在哪**，
// 容易以为这句话没回。
//
// 本刀的判据链（三段，全部有据可依，不新造映射）：
//   ① 投递时落 `steerId`（队列项 id，`steerOrWake` 返回）；
//   ② 队列项落进对话流之后，那个 user 块带 `meta.steerId`、块的 `parent` 就是 turn id
//      ⇒ `local-agent.steerTurnId(taskUri, steerId)` 反查得到（真链路用例见 ③）；
//   ③ 读侧投影 `withSteerTurns` 把 turnId 补进投递状态；UI 判据 `steerTurnRefs` 只挑有地址的那些。
//
// 反证的形状：`steerId` 不落 ⇒ `withSteerTurns` 无所可查（turns 一个都补不出来）——
// 那正是修前"徽章说已投递、用户看不到回复"的实体。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { steerTurnRefs, withSteerTurns, type RoomEvent } from "../../src/shared/room";

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

const sayEvent = (deliveries: RoomEvent["deliveries"]): RoomEvent => ({
  id: "e1",
  ts: "2026-10-20T00:00:00.000Z",
  channel: "default",
  kind: "say",
  author: "human:ccc",
  to: ["agent:main"],
  text: "@main 改一下这个",
  delivered: true,
  ...(deliveries ? { deliveries } : {}),
});

describe("读侧投影 withSteerTurns（steerId ⇒ turnId）", () => {
  it("① 有 steerId + taskUri 且已 ok ⇒ 填上那一轮的 turnId", () => {
    const ev = sayEvent([
      { memberId: "agent:main", status: "ok", taskUri: "projects/1/tasks/1", steerId: "steer/7", ts: "t" },
    ]);
    const got = withSteerTurns([ev], (taskUri, steerId) =>
      taskUri === "projects/1/tasks/1" && steerId === "steer/7" ? "t1792_su" : null,
    );
    expect(got[0]!.deliveries![0]!.turnId).toBe("t1792_su");
  });

  it("② 没有一处变化 ⇒ **返回原数组**（引用稳定：任务页 2.5s 轮询，换引用会惊动视口锚定）", () => {
    const ev = sayEvent([{ memberId: "agent:main", status: "queued", taskUri: "x", ts: "t" }]);
    const events = [ev];
    const got = withSteerTurns(events, () => "should-not-be-used");
    expect(got).toBe(events); // 整个数组都是原引用
    expect(got[0]).toBe(ev);
  });

  it("③ 反查不到（队列项还没落位 / 被取消）⇒ 不猜，保持无 turnId", () => {
    const ev = sayEvent([
      { memberId: "agent:main", status: "ok", taskUri: "projects/1/tasks/1", steerId: "steer/8", ts: "t" },
    ]);
    const got = withSteerTurns([ev], () => null);
    expect(got[0]!.deliveries![0]!.turnId).toBeUndefined();
  });

  it("④ 已有 turnId 不覆盖；未落位（queued）不补", () => {
    const done = sayEvent([
      { memberId: "agent:main", status: "ok", taskUri: "p", turnId: "t-self", steerId: "steer/9", ts: "t" },
      { memberId: "agent:dev", status: "queued", taskUri: "p2", steerId: "steer/10", ts: "t" },
    ]);
    const events = [done];
    const got = withSteerTurns(events, () => "t-other");
    expect(got).toBe(events); // 两条都不该动 ⇒ 没有任何变化
  });

  it("⑤ UI 判据 steerTurnRefs：只挑有地址的投递（skipped 的报错条目不会长出展开入口）", () => {
    const ev = sayEvent([
      { memberId: "agent:main", status: "ok", turnId: "t1", ts: "t" },
      { memberId: "agent:nobody", status: "skipped", error: "房间里没有这个成员", ts: "t" },
    ]);
    expect(steerTurnRefs(ev)).toEqual([{ memberId: "agent:main", turnId: "t1" }]);
  });
});

describe("反查的真链路（`local-agent.steerTurnId`）", () => {
  let PROJECT = "";
  beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "steer-turn-work"));
  });

  it("⑥ 插话落进对话流之后 ⇒ 反查到**消化它的那一轮**（块 meta.steerId → parent）", async () => {
    const uri = createTask({ title: "插话回复归属", project: PROJECT });
    let steerIds: string[] = [];
    let taskUri = uri;
    let calls = 0;
    // 桩模型：第一步就把这条插话**塞进队列**（= 用户趁它在跑时说话），然后给答复收尾。
    // 于是队列项由「轮末整批取走」带进下一轮的开场块（`<turnId>_u2`，meta.steerId 恒带）。
    const model = new MockLanguageModelV3({
      provider: "stub",
      modelId: "stub-model",
      doStream: () => {
        if (calls++ === 0) cookie.add();
        return Promise.resolve(textReply(calls === 1 ? "第一步完成" : "收到插话"));
      },
    }) as unknown as LanguageModel;
    const cookie = {
      add: (): void => {
        steerIds = mgr.steerAdd(taskUri, "next-step", "趁你干活我说一句", "human:ccc").map((it) => it.id);
      },
    };
    const mgr = new LocalAgentManager(() => model);

    for await (const _op of mgr.chat(taskUri, "开工")) {
      // 只驱动，不判 op
    }
    expect(steerIds.length).toBe(1);
    expect(mgr.steerList(taskUri)).toEqual([]); // 已被取走（不是"还躺在 drafts.yaml 里"）

    const ops0 = mgr.history(taskUri);
    const turnId = mgr.steerTurnId(taskUri, steerIds[0]!);
    expect(turnId).toBeTruthy();
    // 那条 turnId 在会话里**真是一轮**（判据取在 ops 上，不是取在返回值上）
    const ops = mgr.history(taskUri);
    expect(ops.some((o) => o.op === "start" && o.kind === "turn" && o.id === turnId)).toBe(true);
    // 承载它的那个 user 块就是它（steerId 对得上）。
    // ⚠️ fold 后的形状：`start.meta` 的键被平铺进块字段 ⇒ steerId 在紧随其后的 `patch.fields` 里
    //（按原始日志形态读 `start.meta` 会永远空 —— 第一版就这么写，这条断言正是抓它的）。
    const carrier = ops.find((o) => o.op === "start" && o.kind === "text" && o.parent === turnId);
    expect(carrier).toBeTruthy();
    const carried = ops
      .filter((o) => o.op === "patch" && o.id === carrier!.id)
      .map((o) => (o.op === "patch" ? o.fields["steerId"] : undefined))
      .find((v) => typeof v === "string");
    expect(carried).toBe(steerIds[0]);
  });

  it("⑦ 不存在的队列项 / 空会话 ⇒ null（如实说「还没进任何一轮」）", () => {
    const uri = createTask({ title: "插话回复归属 空", project: PROJECT });
    const mgr = new LocalAgentManager(() => {
      throw new Error("不该被调用");
    });
    expect(mgr.steerTurnId(uri, "steer/999")).toBeNull();
  });
});
