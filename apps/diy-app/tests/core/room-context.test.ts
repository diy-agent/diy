// tests/core/room-context.test.ts
// 🎯 「room 历史进 agent 上下文」的判据（##377 第 18 刀 / ##166 §44.6）
//
// 投递时给收件人的正文后面附一段「本房间近期发言」—— 四条硬口径全在这里钉住：
//   ① 水位（自上次它被投递以来）② 不重复（本条已单独给了）
//   ③ 不看自己（它自己说过的话它会话里有）④ 上限（20 条 / 4000 字符，取最近的）
//
// 为什么必须是纯函数 + 单测：这四个组合写错的症状都是「多一条 / 少一条」，
// 而它**不在 UI 上直接可见**（藏在 agent 的 user 消息正文里）⇒ 只能靠测试网兜。

import { describe, it, expect } from "vitest";
import { deliveryText, roomContextFor, CONTEXT_MAX_EVENTS, type RoomEvent, type RoomContextItem } from "../../src/shared/room";

/** 只看「谁说了什么」（items 现在还带 id / at，供 runtime 单元用） */
const brief = (items: readonly RoomContextItem[]) => items.map((i) => ({ author: i.author, text: i.text }));

const HUMAN = "human:chen56";
const DEV = "agent:dev";
const MIMO = "agent:mimo2.6";

let seq = 0;
const ev = (author: string, text: string, id?: string): RoomEvent =>
  ({
    id: id ?? `e${1700000000000 + ++seq}_1_x`,
    ts: new Date(1700000000000 + seq).toISOString(),
    channel: "default",
    kind: "say",
    author,
    to: [],
    text,
    delivered: false,
  }) as RoomEvent;

describe("roomContextFor：别人说的话进上下文", () => {
  it("① 人 + agent 各一句 ⇒ 两句都进，作者名正确", () => {
    const events = [ev(HUMAN, "大家好"), ev(DEV, "我在"), ev(HUMAN, "给 mimo 说一句", "e_say")];
    const { items, omitted } = roomContextFor({
      events,
      memberId: MIMO,
      sayId: "e_say",
    });
    expect(brief(items)).toEqual([
      { author: HUMAN, text: "大家好" },
      { author: DEV, text: "我在" },
    ]);
    // runtime 单元要结构化：id（水位/去重的外部键）与 at（时刻）都在
    expect(items[0]!.id).toBeTruthy();
    expect(items[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(omitted).toBe(0);
  });

  it("② 本条 say 不重复（即使它也在水位之后）", () => {
    const mine = ev(HUMAN, "本条自己", "e_say");
    const { items } = roomContextFor({ events: [ev(DEV, "别的话"), mine], memberId: MIMO, sayId: "e_say" });
    expect(items.map((i) => i.text)).toEqual(["别的话"]);
  });

  it("③ 不看自己（它自己说的 / 它的 reply 都跳过）", () => {
    const events = [ev(MIMO, "我说过的话"), ev(HUMAN, "别人说的"), ev(MIMO, "我又说")];
    const { items } = roomContextFor({ events, memberId: MIMO, sayId: "e_say" });
    expect(items.map((i) => i.text)).toEqual(["别人说的"]);
  });

  it("④ 空正文事件不进（失败的 reply 没有信息量，别挤掉真的话）", () => {
    const events = [ev(DEV, ""), ev(DEV, "   "), ev(DEV, "有内容")];
    const { items } = roomContextFor({ events, memberId: MIMO, sayId: "e_say" });
    expect(items.map((i) => i.text)).toEqual(["有内容"]);
  });
});

describe("roomContextFor：水位（lastSeen）", () => {
  it("只取水位**之后**的事件（按流内位置，不按 id 比大小）", () => {
    const a = ev(DEV, "很久以前");
    const b = ev(DEV, "上次看到的最后一条", "e_seen");
    const c = ev(DEV, "这次新的");
    const { items } = roomContextFor({ events: [a, b, c], memberId: MIMO, sayId: "e_say", lastSeenId: "e_seen" });
    expect(items.map((i) => i.text)).toEqual(["这次新的"]);
  });

  it("水位找不到（老房间 / 事件被清过）⇒ 从头算，不崩", () => {
    const { items } = roomContextFor({
      events: [ev(DEV, "甲"), ev(DEV, "乙")],
      memberId: MIMO,
      sayId: "e_say",
      lastSeenId: "e_不存在",
    });
    expect(items.map((i) => i.text)).toEqual(["甲", "乙"]);
  });

  it("水位 = 最新一条 ⇒ 空上下文（判据 4：连投两次，第二次没有段）", () => {
    const last = ev(DEV, "最后一条", "e_last");
    const { items, omitted } = roomContextFor({
      events: [ev(DEV, "更早"), last],
      memberId: MIMO,
      sayId: "e_say",
      lastSeenId: "e_last",
    });
    expect(brief(items)).toEqual([]);
    expect(omitted).toBe(0);
  });
});

describe("roomContextFor：上限（20 条 / 4000 字符，取最近的）", () => {
  it("25 条 ⇒ 只带最近 20 条 + omitted = 5", () => {
    const events = Array.from({ length: 25 }, (_, i) => ev(DEV, `第 ${i} 条`));
    const { items, omitted } = roomContextFor({ events, memberId: MIMO, sayId: "e_say" });
    expect(items).toHaveLength(CONTEXT_MAX_EVENTS);
    expect(omitted).toBe(5);
    expect(items[0]!.text).toBe("第 5 条"); // 取最近的 ⇒ 从第 5 条开始
    expect(items[19]!.text).toBe("第 24 条");
  });

  it("字符上限生效（单条超长 ⇒ 至少保留最近 1 条，不会吐空）", () => {
    const long = "x".repeat(6000);
    const events = [ev(DEV, "早"), ev(DEV, long)];
    const { items, omitted } = roomContextFor({ events, memberId: MIMO, sayId: "e_say" });
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe(long);
    expect(omitted).toBe(1);
  });
});

describe("deliveryText：正文只留人话（##377 第 26 刀：近期发言已搬到 runtime）", () => {
  it("非主人格：房间前缀 + 原话，**没有**近期发言段", () => {
    const out = deliveryText({ roomId: "r", fromName: "chen56", text: "hi" });
    expect(out).toBe("[多人房间 r] chen56 对你说：\nhi");
    expect(out).not.toContain("本房间近期发言");
  });

  it("群发：同一个正文，只是前缀标了「群发」", () => {
    expect(deliveryText({ roomId: "r", fromName: "chen56", text: "hi", toAll: true })).toBe(
      "[多人房间 r · 群发] chen56 对你说：\nhi",
    );
  });

  it("主人格（plain）：正文就是原话，一字不差", () => {
    expect(deliveryText({ roomId: "r", fromName: "chen56", text: "hi", plain: true })).toBe("hi");
  });
});
