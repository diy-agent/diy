// tests/core/room-origin.test.ts
// 🎯 投递来源（##377 第 23 刀）：`meta.author` / `meta.room` 的落与不落，以及气泡标记文案。
//
// 为什么这组判据必须有：`opsOriginFor` 说「不落」的情形（投给主人格 + 发起者是人）
// 是「单人任务逐字不变」的回归网 —— 一旦它多落一个 `room`，任务页那条气泡就会多出
// 「房间投递」标记，与 §44.2 A「无 @ 发送 = 与今天等价」当场冲突。

import { describe, it, expect } from "vitest";
import {
  deliveryBadge,
  HUMAN_MEMBER_ID,
  MAIN_MEMBER_ID,
  opsOriginFor,
  roomDisplayName,
  type DeliveryOrigin,
} from "../../src/shared/room";

const HUMAN = HUMAN_MEMBER_ID; // human:chen56
const DEV = "agent:dev";
const ROOM: DeliveryOrigin = { roomId: "projects/1/tasks/9", sayId: "e1792423748105_12_ab3d" };

describe("opsOriginFor：投递落进成员会话的随附事实", () => {
  it("投给主人格 + 发起者是人 ⇒ 整条不落（含 room —— 否则气泡多出投递标记）", () => {
    expect(opsOriginFor(true, HUMAN, ROOM)).toBeUndefined();
  });

  it("投给主人格 + 发起者是 agent ⇒ author 与 room 都落", () => {
    expect(opsOriginFor(true, DEV, ROOM)).toEqual({ author: DEV, room: ROOM });
  });

  it("投给别的成员 ⇒ 恒落（§40 B 原样，第 23 刀只加 room，不削 author）", () => {
    expect(opsOriginFor(false, HUMAN, ROOM)).toEqual({ author: HUMAN, room: ROOM });
    expect(opsOriginFor(false, DEV, ROOM)).toEqual({ author: DEV, room: ROOM });
  });

  it("room 逐字透传（sayId 是回到房间里找原话的唯一键，不许改写）", () => {
    const o = opsOriginFor(false, HUMAN, ROOM)!;
    expect(o.room?.sayId).toBe(ROOM.sayId);
    expect(o.room?.roomId).toBe(ROOM.roomId);
  });

  it("与 opsAuthorFor 同一把尺（两处不许分家）", () => {
    // 主人格 + 人：author 不落 ⇒ room 也不落
    expect(opsOriginFor(true, HUMAN, ROOM)).toBeUndefined();
    // 其它组合：author 落 ⇒ room 落
    for (const [main, who] of [
      [true, DEV],
      [false, HUMAN],
      [false, DEV],
    ] as const) {
      expect(opsOriginFor(main, who, ROOM)?.author).toBe(who);
    }
  });

  it("主人格 id 也照此规则（不是按字符串硬编码）", () => {
    expect(opsOriginFor(true, HUMAN, ROOM)).toBeUndefined();
    expect(opsOriginFor(true, MAIN_MEMBER_ID, ROOM)?.author).toBe(MAIN_MEMBER_ID);
  });
});

describe("roomDisplayName：气泡上的房间短名（不许出现路径噪音）", () => {
  it("宿主任务的房间 ⇒ 任务号", () => {
    expect(roomDisplayName("projects/1/tasks/9")).toBe("#9");
    expect(roomDisplayName("projects/4/tasks/377")).toBe("#377");
  });

  it("侧边栏房间 ⇒ 实例短名（去掉 sidebar- 前缀）", () => {
    expect(roomDisplayName("agent:room:ui/sidebar-dev-ttipba")).toBe("dev-ttipba");
  });

  it("其它形态退到末段（不崩、不空）", () => {
    expect(roomDisplayName("t377-demo")).toBe("t377-demo");
    expect(roomDisplayName("rooms/2")).toBe("2");
  });
});

describe("deliveryBadge：气泡标记文案", () => {
  it("有来源 ⇒ 画，且带房间短名", () => {
    expect(deliveryBadge(ROOM)).toBe("房间投递 · #9");
  });

  it("无来源 ⇒ null（不画；老数据 / 本人发言逐字不变）", () => {
    expect(deliveryBadge(null)).toBeNull();
    expect(deliveryBadge(undefined)).toBeNull();
    expect(deliveryBadge({ roomId: "", sayId: "e1" })).toBeNull();
  });

  it("侧边栏房间同样可读", () => {
    expect(deliveryBadge({ roomId: "agent:room:ui/sidebar-dev-ttipba", sayId: "e1" })).toBe(
      "房间投递 · dev-ttipba",
    );
  });
});
