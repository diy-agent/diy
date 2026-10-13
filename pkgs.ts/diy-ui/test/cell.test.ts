/**
 * CellHost 单元测试
 * 验证：rerun、错误保留 children、首次执行
 */

import { describe, it, expect } from "vitest";
import { CellHost } from "../src/cell.js";
import { ScopeNode, type ContextManager } from "../src/scope.js";

class TestApp extends ScopeNode implements ContextManager {
  private stack: ScopeNode[] = [this];

  get currentContext(): ScopeNode {
    return this.stack[this.stack.length - 1];
  }

  pushContext(node: ScopeNode): void {
    this.stack.push(node);
  }

  popContext(): void {
    if (this.stack.length > 1) this.stack.pop();
  }
}

describe("CellHost", () => {
  it("首次执行应调用 fn", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);
    let called = false;

    const host = new CellHost(app, node, (_n) => {
      called = true;
    });
    host.rerun();

    expect(called).toBe(true);
  });

  it("rerun 应清空旧 children 后重建", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);
    // 预先添加 child
    const oldChild = new ScopeNode(undefined, node);
    expect(node.children.length).toBe(1);

    const host = new CellHost(app, node, (n) => {
      // cell 内创建新 child
      new ScopeNode(undefined, n);
      new ScopeNode(undefined, n);
    });
    host.rerun();

    expect(node.children.length).toBe(2);
    // 旧 child 不应在 children 中
    expect(node.children).not.toContain(oldChild);
  });

  it("错误时应恢复旧 children", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);
    const oldChild = new ScopeNode(undefined, node);

    const host = new CellHost(app, node, (_n) => {
      new ScopeNode(undefined, _n);
      throw new Error("cell 执行失败");
    });

    expect(() => host.rerun()).toThrow("cell 执行失败");
    // 应恢复到旧 children
    expect(node.children).toContain(oldChild);
    expect(node.children.length).toBe(1);
  });

  it("getDepth 应返回 cellNode 的深度", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);
    const host = new CellHost(app, node, (_n) => {});

    expect(host.getDepth()).toBe(1); // app.depth=0, node.depth=1
  });

  it(".node 应返回 cellNode", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);
    const host = new CellHost(app, node, (_n) => {});

    expect(host.node).toBe(node);
  });

  it("context 应在 rerun 后正确恢复", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);

    const host = new CellHost(app, node, (_n) => {
      expect(app.currentContext).toBe(node);
    });

    expect(app.currentContext).toBe(app);
    host.rerun();
    expect(app.currentContext).toBe(app); // 恢复
  });

  it("错误时 context 也应恢复", () => {
    const app = new TestApp();
    const node = new ScopeNode(undefined, app);

    const host = new CellHost(app, node, (_n) => {
      throw new Error("fail");
    });

    expect(app.currentContext).toBe(app);
    expect(() => host.rerun()).toThrow();
    expect(app.currentContext).toBe(app);
  });
});
