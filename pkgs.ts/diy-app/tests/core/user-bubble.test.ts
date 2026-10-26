// tests/core/user-bubble.test.ts
// 🎯 用户气泡呈现判据（##377 第 14 刀 / ##166 §40 C；##266 review1 R2b 固化）
//
// 口径：**有 author ⇒ 左对齐 + 署名行；无 author ⇒ 右对齐（逐字不变）**。
// "逐字不变"是硬约束 —— 老数据（本人在任务页发言）不带 author，渲染必须与改动前一致。

import { describe, it, expect } from "vitest";
import {
    bubbleAlignClass,
    hasAuthor,
    hasDelivery,
    roomOriginOf,
    systemEventHeadline,
    systemEventLineCount,
    systemEventOf,
} from "../../src/renderer_solid/lib/user-bubble";

describe("用户气泡对齐判据", () => {
  it("有 author ⇒ 左对齐（这句话不是我说的）", () => {
    expect(bubbleAlignClass("agent:166")).toBe("flex justify-start");
    expect(bubbleAlignClass("human:chen56")).toBe("flex justify-start");
  });

  it("无 author ⇒ 右对齐（本人在任务页发言，与改动前逐字一致）", () => {
    expect(bubbleAlignClass(undefined)).toBe("flex justify-end");
    expect(bubbleAlignClass(null)).toBe("flex justify-end");
    expect(bubbleAlignClass("")).toBe("flex justify-end");
  });

  it("署名行与对齐同源：有 author 才画", () => {
    expect(hasAuthor("agent:166")).toBe(true);
    expect(hasAuthor(undefined)).toBe(false);
    expect(hasAuthor("")).toBe(false);
  });
});

// ─── 第 23 刀：房间来源（`meta.room`）──────────────────────
//
// 「有来源 ⇒ 左对齐 + 画标记」与「有 author ⇒ 左对齐」是**同一句语义**：
// 这条 user 块在本会话里不是我说的。两处判据必须同源，否则会出现
// 「左对齐但没有来源说明」或「右对齐却挂着房间标记」这类自相矛盾的气泡。
describe("房间来源判据（##377 第 23 刀）", () => {
  const ROOM = { roomId: "projects/1/tasks/9", sayId: "e1" };

  it("有 room ⇒ 左对齐（即便 author 缺省）", () => {
    expect(bubbleAlignClass(undefined, ROOM)).toBe("flex justify-start");
    expect(bubbleAlignClass("human:chen56", ROOM)).toBe("flex justify-start");
  });

  it("两者都没有 ⇒ 右对齐（老数据 / 本人发言，逐字不变）", () => {
    expect(bubbleAlignClass(undefined, null)).toBe("flex justify-end");
    expect(bubbleAlignClass("", undefined)).toBe("flex justify-end");
  });

  it("roomOriginOf 从块 attrs 解析；形状不对 ⇒ null（不抛）", () => {
    expect(roomOriginOf({ room: ROOM })).toEqual(ROOM);
    expect(roomOriginOf({})).toBeNull();
    expect(roomOriginOf(null)).toBeNull();
    expect(roomOriginOf({ room: "projects/1/tasks/9" })).toBeNull(); // 字符串不是来源对象
    expect(roomOriginOf({ room: { sayId: "e1" } })).toBeNull(); // 没有 roomId
    expect(roomOriginOf({ room: { roomId: "" } })).toBeNull();
  });

  it("sayId 缺省时补空串（来源仍成立，只是回不到原话）", () => {
    expect(roomOriginOf({ room: { roomId: "projects/1/tasks/9" } })).toEqual({
      roomId: "projects/1/tasks/9",
      sayId: "",
    });
  });

  it("hasDelivery 与 roomOriginOf 同源", () => {
    expect(hasDelivery({ room: ROOM })).toBe(true);
    expect(hasDelivery({})).toBe(false);
  });
});

describe("系统事件（##408 v2 C1）", () => {
    it("只有 watch / job 不是人；别的 author 一律当人（含 agent / human）", () => {
        expect(systemEventOf("watch")).toBe("watch");
        expect(systemEventOf("job")).toBe("job");
        expect(systemEventOf("agent:166")).toBeNull();
        expect(systemEventOf("human:chen56")).toBeNull();
        expect(systemEventOf(null)).toBeNull();
        expect(systemEventOf("")).toBeNull();
    });

    it("摘要取首行正文（跳过空行）；正文空也给一句兜底", () => {
        expect(systemEventHeadline("watch daily-pr 有变化\n\n~ a: 1 → 2", "watch")).toBe("watch daily-pr 有变化");
        expect(systemEventHeadline("\n\n后台进程结束 r-1 · 退出码 0", "job")).toBe("后台进程结束 r-1 · 退出码 0");
        expect(systemEventHeadline("  \n ", "watch")).toBe("（观察事件）");
    });

    it("行数只数非空行（折叠条右侧的「N 行」）", () => {
        expect(systemEventLineCount("a\n\nb\n")).toBe(2);
        expect(systemEventLineCount("")).toBe(0);
    });
});
