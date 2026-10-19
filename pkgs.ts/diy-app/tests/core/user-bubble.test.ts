// tests/core/user-bubble.test.ts
// 🎯 用户气泡呈现判据（##377 第 14 刀 / ##166 §40 C；##266 review1 R2b 固化）
//
// 口径：**有 author ⇒ 左对齐 + 署名行；无 author ⇒ 右对齐（逐字不变）**。
// "逐字不变"是硬约束 —— 老数据（本人在任务页发言）不带 author，渲染必须与改动前一致。

import { describe, it, expect } from "vitest";
import { bubbleAlignClass, hasAuthor } from "../../src/renderer_solid/lib/user-bubble";

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
