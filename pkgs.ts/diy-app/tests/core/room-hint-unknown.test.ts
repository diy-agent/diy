// tests/core/room-hint-unknown.test.ts
// 🎯 输入框提示不能骗人（##377 第 20 刀）
//
// 实测现象（修复前）：
//   输入 `@a `      ⇒ 提示「将投递给 a」   ← 服务端随后报「房间里没有这个成员」
//   输入 `@nosuch ` ⇒ 提示「将投递给 nosuch」
// 与 `whyNotDeliverable` 的判据自相矛盾（第 12 刀踩坑 37 的同类："UI 说能投、后端说没有"）。
// 判据：解析不出来的收件人 ⇒ 提示里必须点名 + 给可选名；已知成员照旧。

import { describe, it, expect } from "vitest";
import { deliveryHint, resolveRecipients, type RoomMember } from "../../src/shared/room";

const m = (id: string, name: string, kind: "human" | "agent" = "agent"): RoomMember =>
  ({ id, name, kind, backend: null, ...(kind === "agent" ? { persona: "persona/1" } : {}) }) as RoomMember;

const ROOM = { members: [m("human:chen56", "chen56", "human"), m("agent:main", "deepseek-4.1-flash"), m("agent:for-test", "for-test")] };

describe("deliveryHint —— 打错名（##377 第 20 刀）", () => {
  it("未知收件人：点名 + 给可选名（不再说「将投递给 a」）", () => {
    const h = deliveryHint(["a"], ROOM, "explicit");
    expect(h).toContain("@a 不是房间成员");
    expect(h).toContain("@deepseek-4.1-flash");
    expect(h).not.toContain("将投递给 a");
  });

  it("已知成员照旧", () => {
    expect(deliveryHint(["agent:main"], ROOM, "focus")).toBe("将投递给 deepseek-4.1-flash");
    expect(deliveryHint(["agent:main", "agent:for-test"], ROOM, "all")).toContain("群发");
  });

  it("短名经 resolveRecipients 解析后不再算未知（`@main` 的整条链路）", () => {
    const { recipients, routing } = resolveRecipients(["main"], null, ROOM.members, "human:chen56");
    // resolveRecipients 拿到的是已解析的 tos；这里直接喂已解析结果，验证 hint 不误报
    expect(deliveryHint(["agent:main"], ROOM, routing)).toBe("将投递给 deepseek-4.1-flash");
    expect(recipients.length).toBe(1);
  });

  it("笔记 / 未投递文案不变", () => {
    expect(deliveryHint([], ROOM, "note")).toContain("笔记");
    expect(deliveryHint([], ROOM, "none")).toContain("未投递");
  });
});
