// tests/core/room-member-shortname.test.ts
// 🎯 `@` 寻址认「id 末段短名」（##377 第 20 刀）
//
// 背景（实测）：成员在界面上显示的名字是**人物名**（`deepseek-4.1-flash`），而它的 id 是
// `agent:main` —— 用户凭直觉打 `@main`，得到「房间里没有这个成员」。同一把错还有第二层：
// 那条 reply 的 `author` 会记成原始输入 `main`（不是合法成员 id），UI 上显示成陌生人。
//
// 判据（四条）：
//   ① 精确 id / 精确 name 照旧命中（回归网：老行为一个字不能变）
//   ② id 末段**唯一**时命中（`@main` → `agent:main`）
//   ③ 末段**不唯一**时不猜（保持原样，让"找不到"如实报错，而不是投给错的成员）
//   ④ 找不到时原样返回（外部主体 / 未来扩展的既有语义）

import { describe, it, expect } from "vitest";
import { resolveMember, type RoomMember } from "../../src/shared/room";

const m = (id: string, name: string, kind: "human" | "agent" = "agent"): RoomMember =>
  ({ id, name, kind, backend: null, ...(kind === "agent" ? { persona: "persona/1" } : {}) }) as RoomMember;

const ROOM = {
  members: [
    m("human:chen56", "chen56", "human"),
    m("agent:main", "deepseek-4.1-flash"),
    m("agent:for-test", "for-test"),
  ],
};

describe("resolveMember —— id 末段短名（##377 第 20 刀）", () => {
  it("① 精确 id / 精确 name 照旧", () => {
    expect(resolveMember(ROOM, "agent:main")).toBe("agent:main");
    expect(resolveMember(ROOM, "deepseek-4.1-flash")).toBe("agent:main");
    expect(resolveMember(ROOM, "@for-test")).toBe("agent:for-test");
  });

  it("② id 末段唯一 ⇒ 命中（用户直觉形状 `@main`）", () => {
    expect(resolveMember(ROOM, "main")).toBe("agent:main");
    expect(resolveMember(ROOM, "@main")).toBe("agent:main");
  });

  it("③ 末段不唯一 ⇒ 保持原样（不猜错人）", () => {
    const dup = {
      members: [m("agent:main", "甲"), m("agent:x:main", "乙")],
    };
    expect(resolveMember(dup, "main")).toBe("main");
  });

  it("③' 人成员的末段不参与短名匹配（`@chen56` 走 name 精确，不走末段猜）", () => {
    const onlyHuman = { members: [m("human:other", "某人", "human")] };
    expect(resolveMember(onlyHuman, "other")).toBe("other");
  });

  it("④ 找不到 ⇒ 原样返回", () => {
    expect(resolveMember(ROOM, "nosuchmember")).toBe("nosuchmember");
    expect(resolveMember(null, "main")).toBe("main");
    expect(resolveMember(ROOM, "@")).toBe("@");
  });
});
