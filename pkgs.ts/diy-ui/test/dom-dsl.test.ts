/**
 * keyed 对账（Reconciler）单元测试 —— 行级增量的核心 diff 语义。
 * 无 DOM 环境，故用一个极小的假节点（只需 firstChild/nextSibling/insertBefore/remove）。
 */

import { describe, it, expect } from "vitest";
import { Reconciler, type KeyedChild } from "../src/providers/dom-dsl.js";

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  /** Reconciler 通过 handle.el 取真实节点；这里元素自身即「真实节点」。 */
  get el(): HTMLElement {
    return this as unknown as HTMLElement;
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeEl | null {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return this.parent.children[i + 1] ?? null;
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i, 0, node);
    node.parent = this;
    return node;
  }
  appendChild(node: FakeEl): FakeEl {
    return this.insertBefore(node, null);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  static ids(el: FakeEl): string[] {
    return el.children.map((c) => (c as unknown as { id: string }).id);
  }
}

interface Item {
  id: string;
  rev?: unknown;
}

/** 模拟一次「块重跑」的 keyed 段：与 createEl 的拦截路径同构。 */
function run(
  container: FakeEl,
  prev: Map<unknown, KeyedChild<FakeEl>> | undefined,
  items: Item[],
  make: (it: Item) => FakeEl,
  disposed: string[],
): Map<unknown, KeyedChild<FakeEl>> {
  const rec = new Reconciler<FakeEl>(prev);
  for (const it of items) {
    const rev = "rev" in it ? it.rev : it.id;
    const old = rec.reuse(it.id, rev);
    if (old) {
      rec.keep(it.id, old);
      continue;
    }
    const el = make(it);
    container.insertBefore(el, null);
    rec.put(it.id, rev, el, [(): void => void disposed.push(it.id)]);
  }
  rec.prune();
  rec.reorder(container as unknown as HTMLElement);
  return rec.next;
}

const mk = (it: Item): FakeEl => {
  const e = new FakeEl();
  (e as unknown as { id: string }).id = it.id;
  return e;
};

describe("Reconciler（keyed 行级增量）", () => {
  it("首轮：全部新建，顺序正确", () => {
    const c = new FakeEl();
    const prev = run(c, undefined, [{ id: "a" }, { id: "b" }, { id: "c" }], mk, []);
    expect(FakeEl.ids(c)).toEqual(["a", "b", "c"]);
    expect(prev.size).toBe(3);
  });

  it("同 key 同 rev：复用，不重建、不动 DOM、不释放", () => {
    const c = new FakeEl();
    const disposed: string[] = [];
    const p1 = run(c, undefined, [{ id: "a" }, { id: "b" }], mk, disposed);
    const before = c.children.slice();
    const p2 = run(c, p1, [{ id: "a" }, { id: "b" }], mk, disposed);
    expect(FakeEl.ids(c)).toEqual(["a", "b"]);
    expect(c.children[0]).toBe(before[0]); // 同一个节点
    expect(c.children[1]).toBe(before[1]);
    expect(disposed).toEqual([]);
    expect(p2.size).toBe(2);
  });

  it("追加：旧行复用，只建新行（append 场景零移动）", () => {
    const c = new FakeEl();
    const disposed: string[] = [];
    const p1 = run(c, undefined, [{ id: "a" }, { id: "b" }], mk, disposed);
    const a = c.children[0];
    const p2 = run(c, p1, [{ id: "a" }, { id: "b" }, { id: "c" }], mk, disposed);
    expect(FakeEl.ids(c)).toEqual(["a", "b", "c"]);
    expect(c.children[0]).toBe(a); // a 未动
    expect(disposed).toEqual([]);
    expect(p2.size).toBe(3);
  });

  it("删除：只拆被删行（释放作用域 + 移除 DOM）", () => {
    const c = new FakeEl();
    const disposed: string[] = [];
    const p1 = run(c, undefined, [{ id: "a" }, { id: "b" }, { id: "c" }], mk, disposed);
    const a = c.children[0];
    const cc = c.children[2];
    const p2 = run(c, p1, [{ id: "a" }, { id: "c" }], mk, disposed);
    expect(FakeEl.ids(c)).toEqual(["a", "c"]);
    expect(disposed).toEqual(["b"]);
    expect(c.children[0]).toBe(a);
    expect(c.children[1]).toBe(cc);
    expect(p2.size).toBe(2);
  });

  it("换序：复用节点，仅移动错位者", () => {
    const c = new FakeEl();
    const p1 = run(c, undefined, [{ id: "a" }, { id: "b" }, { id: "c" }], mk, []);
    const a = c.children[0];
    const b = c.children[1];
    const cc = c.children[2];
    run(c, p1, [{ id: "c" }, { id: "a" }, { id: "b" }], mk, []);
    expect(FakeEl.ids(c)).toEqual(["c", "a", "b"]);
    expect(c.children[0]).toBe(cc);
    expect(c.children[1]).toBe(a);
    expect(c.children[2]).toBe(b);
  });

  it("同 key 但 rev 变：只重建这一行（旧节点释放）", () => {
    const c = new FakeEl();
    const disposed: string[] = [];
    const p1 = run(c, undefined, [{ id: "a", rev: "v1" }, { id: "b", rev: "v1" }], mk, disposed);
    const aOld = c.children[0];
    run(c, p1, [{ id: "a", rev: "v2" }, { id: "b", rev: "v1" }], mk, disposed);
    expect(FakeEl.ids(c)).toEqual(["a", "b"]);
    expect(c.children[0]).not.toBe(aOld); // a 重建
    expect(c.children[1]).toBe(p1.get("b")!.el); // b 复用
    expect(disposed).toEqual(["a"]);
  });
});
