/**
 * 基础组件单元测试
 * 验证：组件创建、render、作用域
 */

import { describe, it, expect } from "vitest";
import { ScopeNode, ScopeConfig } from "../src/scope.js";
import {
  UIComponent,
  ContainerComponent,
  LeafComponent,
} from "../src/components.js";
import { Container as PiContainer } from "@mariozechner/pi-tui";

// ── 测试用叶子组件 ──────────────────────────────────────

class TestLeaf extends LeafComponent {
  private text: string;
  constructor(text: string, parent?: ScopeNode) {
    super(undefined, parent);
    this.text = text;
  }
  render(_width: number): string[] {
    return [this.text];
  }
}

// ── 测试用容器组件 ──────────────────────────────────────

class TestContainer extends ContainerComponent {
  constructor(parent?: ScopeNode) {
    super(undefined, parent);
  }
}

// ── 测试 ────────────────────────────────────────────────

describe("UIComponent", () => {
  it("应继承 ScopeNode", () => {
    const comp = new TestLeaf("hello");
    expect(comp).toBeInstanceOf(ScopeNode);
  });

  it("应实现 Component 接口", () => {
    const comp = new TestLeaf("hello");
    expect(typeof comp.render).toBe("function");
    expect(typeof comp.invalidate).toBe("function");
  });

  it("叶子组件不应有 children 管理方法", () => {
    const leaf = new TestLeaf("hello");
    // LeafComponent 不添加 piContainer 属性
    expect((leaf as any).piContainer).toBeUndefined();
  });
});

describe("ContainerComponent", () => {
  it("应有 piContainer", () => {
    const container = new TestContainer();
    expect(container.piContainer).toBeInstanceOf(PiContainer);
  });

  it("应将子 UIComponent 添加到 piContainer", () => {
    const container = new TestContainer();
    const leaf = new TestLeaf("child", container);
    container.addPiChild(leaf);

    expect(container.piContainer.children).toContain(leaf);
  });

  it("clearChildren 应同时清空 piContainer", () => {
    const container = new TestContainer();
    const leaf = new TestLeaf("child", container);
    container.addPiChild(leaf);

    container.clearChildren();
    expect(container.children.length).toBe(0);
    expect(container.piContainer.children.length).toBe(0);
  });

  it("容器与子组件应有正确的父子关系", () => {
    const container = new TestContainer();
    const leaf = new TestLeaf("child", container);

    expect(leaf.parent).toBe(container);
    expect(container.children).toContain(leaf);
  });
});
