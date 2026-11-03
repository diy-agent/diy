/**
 * 意图测试（feature / intent 视角）—— 只断言用户能感知的行为，不碰内部字段。
 *
 * 覆盖的「特性」：
 *   1. 移除 / 清空 / 全量替换子节点后，**渲染结果**跟着变（树与原生渲染不分叉）
 *   2. cell 重跑抛错时，界面上仍是**上一次成功**的内容（回滚对渲染生效）
 *   3. 销毁节点会停掉它登记的清理回调，并**递归**到子节点（不留幽灵副作用）
 */

import { describe, it, expect } from "vitest";
import { ContainerComponent, LeafComponent } from "../src/components.js";
import { CellHost } from "../src/cell.js";
import type { ContextManager, ScopeNode } from "../src/scope.js";

class Col extends ContainerComponent {}
class Txt extends LeafComponent {
  constructor(
    private readonly text: string,
    parent?: ScopeNode,
  ) {
    super(undefined, parent); // LeafComponent 构造时已自动挂到父容器
  }
  render(): string[] {
    return [this.text];
  }
}

/** CellHost 只用到 ContextManager 的 push/pop；这里给个空实现。 */
const ctxMgr = {
  currentContext: undefined,
  pushContext() {},
  popContext() {},
} as unknown as ContextManager;

describe("特性：容器增删子节点 → 渲染跟着变", () => {
  it("移除一个子节点后，它不再出现在渲染结果里", () => {
    const root = new Col();
    const a = new Txt("A", root);
    const b = new Txt("B", root);
    expect(root.render(80)).toEqual(["A", "B"]);

    root.removeChild(a);
    expect(root.render(80)).toEqual(["B"]);
    expect(b.children.length).toBe(0);
  });

  it("清空后渲染为空，逻辑树也为空", () => {
    const root = new Col();
    new Txt("A", root);
    new Txt("B", root);

    root.clearChildren();
    expect(root.render(80)).toEqual([]);
    expect(root.children).toEqual([]);
  });

  it("全量替换后，渲染结果与新的子树一致", () => {
    const root = new Col();
    const old = new Txt("old", root);
    const fresh = new Txt("fresh");
    fresh.parent = root;

    root.replaceChildren([fresh]);
    expect(root.render(80)).toEqual(["fresh"]);
    expect(root.children).toEqual([fresh]);
    expect(old.children.length).toBe(0);
  });
});

describe("特性：叶子创建即挂载（不用手动挂）", () => {
  it("new Text(...) 直接出现在父容器的渲染里", () => {
    const root = new Col();
    new Txt("auto", root);
    expect(root.render(80)).toEqual(["auto"]);
  });
});

describe("特性：cell 重跑失败时，界面保持上一次成功的内容", () => {
  it("抛错的那一轮不会把半成品留在渲染里", () => {
    const root = new Col();
    let fail = false;

    const host = new CellHost(ctxMgr, root, (node) => {
      new Txt(fail ? "broken" : "ok", node);
      if (fail) throw new Error("boom");
    });

    host.rerun(); // 首轮成功
    expect(root.render(80)).toEqual(["ok"]);

    fail = true;
    expect(() => host.rerun()).toThrow("boom");

    // 意图：失败不改变用户看到的内容
    expect(root.render(80)).toEqual(["ok"]);
    expect(root.children.length).toBe(1);

    fail = false;
    host.rerun();
    expect(root.render(80)).toEqual(["ok"]);
  });
});

describe("特性：销毁 = 停副作用 + 递归 + 摘树", () => {
  it("销毁节点会执行它登记的清理回调，并从父节点摘除", () => {
    const root = new Col();
    const child = new Txt("x", root);
    let cleaned = 0;
    child.onDispose(() => cleaned++);

    child.dispose();
    expect(cleaned).toBe(1);
    expect(root.children).toEqual([]);
    expect(root.render(80)).toEqual([]);
  });

  it("销毁父节点会递归销毁所有后代（清理回调各执行一次）", () => {
    const root = new Col();
    const mid = new Col(undefined, root);
    const leaf = new Txt("leaf", mid);

    const hits: string[] = [];
    root.onDispose(() => hits.push("root"));
    mid.onDispose(() => hits.push("mid"));
    leaf.onDispose(() => hits.push("leaf"));

    root.dispose();
    expect(hits.sort()).toEqual(["leaf", "mid", "root"]);
    expect(root.children).toEqual([]);
    expect(mid.children).toEqual([]);
  });

  it("在已销毁的节点上登记清理回调会立刻执行（不静默丢）", () => {
    const node = new Col();
    node.dispose();
    let called = 0;
    node.onDispose(() => called++);
    expect(called).toBe(1);
  });

  it("重复销毁是幂等的（清理回调只执行一次）", () => {
    const node = new Col();
    let called = 0;
    node.onDispose(() => called++);
    node.dispose();
    node.dispose();
    expect(called).toBe(1);
  });
});
