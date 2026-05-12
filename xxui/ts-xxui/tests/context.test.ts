/**
 * Context 栈单元测试
 * 验证：回调函数内的当前上下文正确设置，模拟 app.column(() => { ... }) 模式
 */

import { describe, it, expect } from "vitest";
import { ScopeNode, ScopeConfig, type ContextManager } from "../src/scope.js";

// ── 模拟 App 的 contextStack 实现 ────────────────────────

class MockApp extends ScopeNode implements ContextManager {
  private contextStack: ScopeNode[] = [this];

  get currentContext(): ScopeNode {
    return this.contextStack[this.contextStack.length - 1];
  }

  pushContext(node: ScopeNode): void {
    this.contextStack.push(node);
  }

  popContext(): void {
    if (this.contextStack.length > 1) {
      this.contextStack.pop();
    }
  }

  /** 创建容器并推入 context 栈（模拟 app.column()） */
  createContainer(
    createFn: (app: MockApp) => ScopeNode,
    childrenFn: (ctx: ScopeNode) => void
  ): ScopeNode {
    const container = createFn(this);
    this.pushContext(container);
    try {
      childrenFn(container);
    } finally {
      this.popContext();
    }
    return container;
  }
}

describe("Context 栈（回调构树）", () => {
  it("app.createContainer 应将组件挂载到正确的父级", () => {
    const app = new MockApp();
    const created: ScopeNode[] = [];

    app.createContainer(
      (app) => new ScopeNode(undefined, app.currentContext),
      (ctx) => {
        // 在容器内创建子组件 — 应挂载到 ctx
        const child = new ScopeNode(undefined, app.currentContext);
        created.push(child);
        expect(app.currentContext).toBe(ctx);
      }
    );

    // 容器外的 context 应恢复为 app
    expect(app.currentContext).toBe(app);

    // 子组件应挂载到容器而非 app
    expect(created.length).toBe(1);
    expect(created[0].parent).not.toBe(app);
  });

  it("嵌套容器应正确推入弹出 context", () => {
    const app = new MockApp();
    const parents: (ScopeNode | undefined)[] = [];

    app.createContainer(
      (app) => new ScopeNode(undefined, app.currentContext),
      (outer) => {
        // 在 outer 内创建子组件
        const inOuter = new ScopeNode(undefined, app.currentContext);
        parents.push(inOuter.parent);

        // 嵌套容器
        app.createContainer(
          (app) => new ScopeNode(undefined, app.currentContext),
          (inner) => {
            const inInner = new ScopeNode(undefined, app.currentContext);
            parents.push(inInner.parent);
            expect(app.currentContext).toBe(inner);
          }
        );

        // 嵌套后恢复 outer
        expect(app.currentContext).toBe(outer);
      }
    );

    // 最终恢复 app
    expect(app.currentContext).toBe(app);

    // 验证挂载关系
    expect(parents[0]).not.toBe(app); // inOuter 挂在 outer
    expect(parents[1]).not.toBe(app); // inInner 挂在 inner
  });

  it("异常时 finally 应恢复 context（不泄漏）", () => {
    const app = new MockApp();

    try {
      app.createContainer(
        (app) => new ScopeNode(undefined, app.currentContext),
        (_ctx) => {
          throw new Error("组件创建失败");
        }
      );
    } catch {
      // 预期异常
    }

    // Context 应被恢复
    expect(app.currentContext).toBe(app);
  });

  it("嵌套异常应逐层恢复 context", () => {
    const app = new MockApp();

    try {
      app.createContainer(
        (app) => new ScopeNode(undefined, app.currentContext),
        (outer) => {
          new ScopeNode(undefined, app.currentContext);

          try {
            app.createContainer(
              (app) => new ScopeNode(undefined, app.currentContext),
              (_inner) => {
                throw new Error("内部失败");
              }
            );
          } catch {
            // 捕获内部异常，继续
          }

          // 应该恢复到 outer
          expect(app.currentContext).toBe(outer);
        }
      );
    } catch {
      // 不应到达这里
    }

    expect(app.currentContext).toBe(app);
  });
});
