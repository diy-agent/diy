// tests/core/ui-text.test.ts — 点击命中校验的文本比较（##255 R2-1 回归）
//
// 历史上这段逻辑写在模板字面量里，`\s` 被吃成字母 s（正则变成「剥字母 s」），
// 对含空格文本（如「MD 原文」）恒判未命中 → 点击前的遮挡校验空转 ~19s 才放弃。
// 这里把它钉死，并额外守住「可 toString 注入浏览器」这条契约。
import { describe, expect, it } from "vitest";
import { textHit } from "../ui-text";

describe("textHit —— 命中元素文本与期望文本是否同一目标", () => {
  it("含空格的文本：命中（旧实现的回归点）", () => {
    expect(textHit("MD 原文", "MD 原文")).toBe(true);
    expect(textHit("已压缩 3 条", "已压缩")).toBe(true);
  });

  it("空白写法差异不算差异（两侧都去空白）", () => {
    expect(textHit("MD   原文", "MD 原文")).toBe(true);
    expect(textHit("  MD\n原文  ", "MD 原文")).toBe(true);
  });

  it("拉丁字母 s 不被剥掉（旧实现把 s 当空白剥）", () => {
    expect(textHit("s", "s")).toBe(true);
    expect(textHit("status", "status")).toBe(true);
  });

  it("从头/尾互含即算命中（a11y 名与 DOM 文本常有细微差异）", () => {
    expect(textHit("已压缩…", "已压缩")).toBe(true);
    expect(textHit("编号", "编号 名称")).toBe(true);
  });

  it("超长文本（整页容器）不算命中", () => {
    expect(textHit("x".repeat(201) + "目标", "目标")).toBe(false);
  });

  it("空串 / 不匹配 → 不算命中", () => {
    expect(textHit("", "目标")).toBe(false);
    expect(textHit("目标", "")).toBe(false);
    expect(textHit("甲", "乙")).toBe(false);
  });

  it("可 toString 后注入隔离作用域求值（注入契约：必须自包含）", () => {
    // ui-drive 把它 toString() 后注入浏览器 —— 若引用了本模块其它导出，浏览器里会 ReferenceError。
    const isolated = new Function(`return (${textHit.toString()})`)() as typeof textHit;
    expect(isolated("MD 原文", "MD 原文")).toBe(true);
    expect(isolated("s", "s")).toBe(true);
    expect(isolated("甲", "乙")).toBe(false);
  });
});
