// tests/core/local-blocks-steer-compat.test.ts
// 🎯 插话对 **Op 流格式**的影响：只加一个可选字段，双向兼容（不是破坏性变更）
//
// 背景：ops.jsonl 是「传输协议 = 存储格式 = UI 渲染输入」三合一的日志，没有版本字段，
// 靠的是**加字段不破坏旧读者**（前向兼容）与**旧日志不要求新字段**（后向兼容）。
// 插话只做了一件事：给 user 的 text 块加 `meta.steer = "step" | "turn"`。
// 本文件把这条契约钉死 —— 将来谁想改成"新 op 动词"或"新增块 kind"，
// 这些用例会立刻红，逼他先想清楚要不要给 ops 加版本与迁移。

import { describe, it, expect } from "vitest";
import { BlockStore, blocksToMessages, replay, toTree, type Op } from "../../src/main/services/local-blocks";

/** 本功能上线前就存在的日志形状（老版本 diy 写的 ops） */
const OLD_OPS: Op[] = [
  { op: "start", id: "t1", kind: "turn", meta: { model: "gpt-5.6-luna" } },
  { op: "start", id: "t1_u", kind: "text", parent: "t1", meta: { role: "user" } },
  { op: "delta", id: "t1_u", fields: { content: "老用户消息" } },
  { op: "stop", id: "t1_u" },
  { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
  { op: "start", id: "t1_a1", kind: "text", parent: "t1_s1", meta: { role: "assistant" } },
  { op: "delta", id: "t1_a1", fields: { content: "老答复" } },
  { op: "stop", id: "t1_a1" },
  { op: "stop", id: "t1_s1" },
  { op: "stop", id: "t1" },
];

/** 本功能上线后的日志形状：多一个 steer 字段与一个插话块 */
const NEW_OPS: Op[] = [
  { op: "start", id: "t2", kind: "turn", meta: { model: "mimo-v2.6-flash" } },
  { op: "start", id: "t2_u", kind: "text", parent: "t2", meta: { role: "user" } },
  { op: "delta", id: "t2_u", fields: { content: "本轮开场消息" } },
  { op: "stop", id: "t2_u" },
  { op: "start", id: "t2_s1", kind: "step", parent: "t2" },
  { op: "start", id: "t2_su1", kind: "text", parent: "t2", meta: { role: "user", steer: "step" } },
  { op: "delta", id: "t2_su1", fields: { content: "插嘴的话" } },
  { op: "stop", id: "t2_su1" },
  { op: "start", id: "t2_s2", kind: "step", parent: "t2" },
  { op: "stop", id: "t2_s2" },
  { op: "stop", id: "t2_s1" },
  { op: "stop", id: "t2" },
];

describe("Op 流兼容：插话只加可选字段", () => {
  it("老日志（无 steer）在新代码里 fold 零 issue（后向兼容）", () => {
    const s = replay(OLD_OPS);
    expect(s.issues).toEqual([]);
    const user = s.blocks.get("t1_u")!;
    expect(user.steer).toBeUndefined();
    // UI 侧读 attrs.steer 得 undefined → 不渲染插话标记（Show 条件不成立）
    expect(toTree(s, "t1").children[0]!.attrs["steer"]).toBeUndefined();
  });

  it("新日志（带 steer）fold 零 issue（前向兼容的根据：meta 走 start 落位，不经过字段类型表）", () => {
    const s = replay(NEW_OPS);
    expect(s.issues).toEqual([]);
    expect(s.blocks.get("t2_su1")!.steer).toBe("step");
    expect(toTree(s, "t2").children.find((c) => c.id === "t2_su1")!.attrs["steer"]).toBe("step");
    // 插话块挂在 turn 下（不是 step 下）：文档序 = 「第 1 步之后、第 2 步之前」，
    // 而 step 容器负责表达"这两步属于同一轮" —— 两者不冲突
    expect(s.blocks.get("t2_su1")!.parent).toBe("t2");
  });

  it("steer 是 text 块的「声明字段」：用 patch 写它不产生 issue（不再靠未声明字段降级兜着）", () => {
    const s = new BlockStore();
    for (const op of NEW_OPS) s.apply(op);
    s.apply({ op: "patch", id: "t2_su1", fields: { steer: "turn" } });
    expect(s.issues).toEqual([]);
    expect(s.blocks.get("t2_su1")!.steer).toBe("turn");
  });

  it("不认识 steer 的旧读者也能 work：块字段是白名单外自由扩展，投影只关心 role/content", () => {
    const s = replay(NEW_OPS);
    const msgs = blocksToMessages(s);
    // 插话块就是一条普通 user 消息（模型不需要知道它是"插进来的"）
    expect(msgs.map((m) => [m.role, typeof m.content === "string" ? m.content : ""])).toEqual([
      ["user", "本轮开场消息"],
      ["user", "插嘴的话"],
    ]);
  });

  it("审计：插话没有引入新的 op 动词 / 块 kind（旧读者不会遇到「未知 op」）", () => {
    const verbs = new Set(NEW_OPS.map((o) => o.op));
    const kinds = new Set(NEW_OPS.filter((o) => o.op === "start").map((o) => (o as { kind: string }).kind));
    expect([...verbs].sort()).toEqual(["delta", "start", "stop"]);
    expect([...kinds].sort()).toEqual(["step", "text", "turn"]);
  });
});
