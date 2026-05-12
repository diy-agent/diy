/**
 * ScopeNode + ScopeConfig 单元测试
 * 验证：config 继承、children 管理、signal 注册/查找、ContextManager
 */

import { describe, it, expect } from "vitest";
import { ScopeNode, ScopeConfig, type Scheduler, type ContextManager } from "../src/scope.js";
import { Signal } from "../src/signal.js";

// ── 测试用 Scheduler ──────────────────────────────────────

class NoopScheduler implements Scheduler {
  scheduled: unknown[] = [];
  schedule(cell: unknown): void { this.scheduled.push(cell); }
  flush(): void {}
}

class DevScheduler implements Scheduler {
  schedule(_cell: unknown): void {}
  flush(): void {}
}

// ── 测试用 ContextManager ─────────────────────────────────

class TestApp extends ScopeNode implements ContextManager {
  private _stack: ScopeNode[] = [this];

  get currentContext(): ScopeNode {
    return this._stack[this._stack.length - 1];
  }

  pushContext(node: ScopeNode): void {
    this._stack.push(node);
  }

  popContext(): void {
    if (this._stack.length > 1) {
      this._stack.pop();
    }
  }
}

// ── ScopeConfig ───────────────────────────────────────────

describe("ScopeConfig", () => {
  it("空构造应产生空 config", () => {
    const c = new ScopeConfig();
    expect(c.mode).toBeUndefined();
    expect(c.scheduler).toBeUndefined();
    expect(c.maxRerunDepth).toBeUndefined();
  });

  it("应能设置 mode", () => {
    const c = new ScopeConfig({ mode: "prod" });
    expect(c.mode).toBe("prod");
  });

  it("应能设置 scheduler", () => {
    const s = new NoopScheduler();
    const c = new ScopeConfig({ scheduler: s });
    expect(c.scheduler).toBe(s);
  });

  it("应能设置 maxRerunDepth", () => {
    const c = new ScopeConfig({ maxRerunDepth: 50 });
    expect(c.maxRerunDepth).toBe(50);
  });
});

// ── ScopeNode ─────────────────────────────────────────────

describe("ScopeNode", () => {
  it("应能创建根节点", () => {
    const node = new ScopeNode();
    expect(node.parent).toBeUndefined();
    expect(node.children).toEqual([]);
    expect(node.depth).toBe(0);
  });

  it("应能创建子节点并建立父子关系", () => {
    const parent = new ScopeNode();
    const child = new ScopeNode(undefined, parent);
    expect(child.parent).toBe(parent);
    expect(parent.children).toContain(child);
  });

  it("depth 应正确计算", () => {
    const root = new ScopeNode();
    const child = new ScopeNode(undefined, root);
    const grandchild = new ScopeNode(undefined, child);
    expect(root.depth).toBe(0);
    expect(child.depth).toBe(1);
    expect(grandchild.depth).toBe(2);
  });

  it("clearChildren 应清空子节点", () => {
    const parent = new ScopeNode();
    new ScopeNode(undefined, parent);
    new ScopeNode(undefined, parent);
    expect(parent.children.length).toBe(2);
    parent.clearChildren();
    expect(parent.children).toEqual([]);
  });

  it("replaceChildren 应替换子节点", () => {
    const parent = new ScopeNode();
    new ScopeNode(undefined, parent);
    const newChild = new ScopeNode();
    parent.replaceChildren([newChild]);
    expect(parent.children).toEqual([newChild]);
  });

  it("removeChild 应移除指定子节点", () => {
    const parent = new ScopeNode();
    const child = new ScopeNode(undefined, parent);
    parent.removeChild(child);
    expect(parent.children).toEqual([]);
  });

  // ── 配置继承 ──────────────────────────────────────────

  it("getEffectiveMode 默认应为 dev", () => {
    const node = new ScopeNode();
    expect(node.getEffectiveMode()).toBe("dev");
  });

  it("getEffectiveMode 应从祖先继承", () => {
    const root = new ScopeNode(new ScopeConfig({ mode: "prod" }));
    const child = new ScopeNode(undefined, root);
    expect(child.getEffectiveMode()).toBe("prod");
  });

  it("getEffectiveMode 应优先使用自己的配置", () => {
    const root = new ScopeNode(new ScopeConfig({ mode: "prod" }));
    const child = new ScopeNode(new ScopeConfig({ mode: "dev" }), root);
    expect(child.getEffectiveMode()).toBe("dev");
  });

  it("getEffectiveScheduler 应从祖先继承", () => {
    const s = new NoopScheduler();
    const root = new ScopeNode(new ScopeConfig({ scheduler: s }));
    const child = new ScopeNode(undefined, root);
    expect(child.getEffectiveScheduler()).toBe(s);
  });

  it("getEffectiveScheduler 没配置时应抛出", () => {
    const node = new ScopeNode();
    expect(() => node.getEffectiveScheduler()).toThrow(
      "No scheduler configured"
    );
  });

  it("getEffectiveMaxRerunDepth 默认应为 100", () => {
    const node = new ScopeNode();
    expect(node.getEffectiveMaxRerunDepth()).toBe(100);
  });

  it("getEffectiveMaxRerunDepth 应从祖先继承", () => {
    const root = new ScopeNode(new ScopeConfig({ maxRerunDepth: 50 }));
    const child = new ScopeNode(undefined, root);
    expect(child.getEffectiveMaxRerunDepth()).toBe(50);
  });

  // ── signal 注册 ────────────────────────────────────────

  it("应能注册和查找 signal 拥有者", () => {
    const node = new ScopeNode();
    const sig = new Signal(42);
    node.registerSignal(sig);
    expect(node.ownsSignal(sig)).toBe(true);
    expect(node.findSignalOwner(sig)).toBe(node);
  });

  it("应在子树中递归查找 signal 拥有者", () => {
    const root = new ScopeNode();
    const child = new ScopeNode(undefined, root);
    const sig = new Signal(42);
    child.registerSignal(sig);

    expect(child.ownsSignal(sig)).toBe(true);
    expect(root.findSignalOwner(sig)).toBe(child);
  });

  it("未注册的 signal 不应有拥有者", () => {
    const node = new ScopeNode();
    const sig = new Signal(42);
    expect(node.ownsSignal(sig)).toBe(false);
    expect(node.findSignalOwner(sig)).toBeNull();
  });
});

// ── ContextManager ────────────────────────────────────────

describe("ContextManager (App)", () => {
  it("currentContext 初始应为 app 自身", () => {
    const app = new TestApp();
    expect(app.currentContext).toBe(app);
  });

  it("pushContext 应更新 currentContext", () => {
    const app = new TestApp();
    const child = new ScopeNode(undefined, app);
    app.pushContext(child);
    expect(app.currentContext).toBe(child);
  });

  it("popContext 应恢复上一个上下文", () => {
    const app = new TestApp();
    const child = new ScopeNode(undefined, app);
    app.pushContext(child);
    app.popContext();
    expect(app.currentContext).toBe(app);
  });

  it("多次嵌套 push/pop 应正确工作", () => {
    const app = new TestApp();
    const a = new ScopeNode(undefined, app);
    const b = new ScopeNode(undefined, app);

    app.pushContext(a);
    expect(app.currentContext).toBe(a);

    app.pushContext(b);
    expect(app.currentContext).toBe(b);

    app.popContext();
    expect(app.currentContext).toBe(a);

    app.popContext();
    expect(app.currentContext).toBe(app);
  });

  it("不应 pop 根节点", () => {
    const app = new TestApp();
    app.popContext(); // 不应该崩溃
    expect(app.currentContext).toBe(app);
  });
});
