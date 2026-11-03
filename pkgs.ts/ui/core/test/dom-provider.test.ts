/**
 * 意图测试（feature / intent 视角）—— DOM provider 的用户可感知行为。
 *
 * 覆盖的「特性」：
 *   1. cell 读到信号 → 内容跟着信号变
 *   2. 节点销毁后，信号再变**不再**产生任何更新（销毁即静默）
 *   3. 外层 cell 重跑后，上一轮的内层 cell 不再响应信号（无幽灵订阅）
 *   4. cell 里用 app.xxx() 建的内容，落在该 cell 内（不是根节点）
 *   5. cell 抛错时，界面保留上一次成功的内容
 *   6. 节点被移除后，rerun 统计不再持有它（不泄漏）
 *
 * 用 test/fake-dom.ts 的最小 DOM（仓库既有做法：无 DOM 环境用假节点）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakeDom, type FakeElement } from "./fake-dom.js";
import { DomApp } from "../src/providers/dom.js";
import { DslApp, allNodes } from "../src/providers/dom-dsl.js";
import { Signal } from "../src/signal.js";

let restore: () => void;
beforeEach(() => {
  restore = installFakeDom();
});
afterEach(() => {
  restore();
});

const el = (tag = "div"): FakeElement =>
  (globalThis as unknown as { document: { createElement(t: string): FakeElement } }).document.createElement(
    tag,
  );

/** 子树里所有带某个 class 的元素。 */
function collect(root: FakeElement, cls: string): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    for (const c of n.children) {
      if (c.className.split(/\s+/).includes(cls)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

describe("特性：cell 跟随信号", () => {
  it("信号变化后，界面上是新的值", () => {
    const mount = el();
    const app = new DomApp({ mount: mount as unknown as HTMLElement });
    const n = new Signal(1);
    const col = app.column();
    col.cell((stage) => {
      stage.text(String(n.value));
    });

    expect(mount.textContent).toBe("1");
    n.value = 2;
    expect(mount.textContent).toBe("2");
  });
});

describe("特性：销毁即静默", () => {
  it("节点销毁后，信号变化不再引起重跑", () => {
    const mount = el();
    const app = new DomApp({ mount: mount as unknown as HTMLElement });
    const n = new Signal(1);
    let runs = 0;
    const col = app.column();
    col.cell((stage) => {
      runs++;
      stage.text(String(n.value));
    });

    expect(runs).toBe(1);
    n.value = 2;
    expect(runs).toBe(2);

    col.dispose();
    n.value = 3;
    expect(runs).toBe(2); // 销毁后不再跑
    expect(mount.textContent).toBe(""); // 且已从界面摘除
  });
});

describe("特性：嵌套 cell 不留幽灵订阅", () => {
  it("外层重跑后，上一轮的内层 cell 不再响应内层信号", () => {
    const mount = el();
    const app = new DomApp({ mount: mount as unknown as HTMLElement });
    const outer = new Signal(0);
    const inner = new Signal(0);
    let innerRuns = 0;

    const box = app.column();
    box.cell((stage) => {
      void outer.value;
      const sub = stage.column();
      sub.cell((s2) => {
        innerRuns++;
        s2.text(String(inner.value));
      });
    });

    expect(innerRuns).toBe(1);
    outer.value = 1; // 外层重跑 → 内层重建一次
    expect(innerRuns).toBe(2);
    inner.value = 1; // 只有存活的那个内层响应
    expect(innerRuns).toBe(3);
  });
});

describe("特性：cell 内的 app.xxx() 落在 cell 自己里", () => {
  it("用 app.text() 建的内容与 cell 内容在同一子树中", () => {
    const mount = el();
    const app = new DomApp({ mount: mount as unknown as HTMLElement });
    const col = app.column();
    col.cell((stage) => {
      app.text("via-app");
      stage.text("via-stage");
    });

    const inside = collect(col.el as unknown as FakeElement, "diy-text");
    expect(inside.map((e) => e.textContent)).toEqual(["via-app", "via-stage"]);
  });
});

describe("特性：cell 抛错时界面保留上一次成功的内容", () => {
  it("失败的一轮不把半成品留在界面上", () => {
    const mount = el();
    const app = new DomApp({ mount: mount as unknown as HTMLElement });
    const trigger = new Signal(0);
    let fail = false;
    const col = app.column();
    col.cell((stage) => {
      void trigger.value;
      stage.text(fail ? "broken" : "ok");
      if (fail) throw new Error("boom");
    });

    expect(mount.textContent).toBe("ok");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fail = true;
    trigger.value = 1; // 重跑 → 抛错
    expect(mount.textContent).toBe("ok"); // 意图：失败不改界面

    fail = false;
    trigger.value = 2; // 恢复后能继续正常更新
    expect(mount.textContent).toBe("ok");
    spy.mockRestore();
  });
});

describe("特性：误用异步尾部函数会立刻报错（而不是静默空块）", () => {
  it("dom-dsl 收到 async / generator 尾部函数时报错并指出替代方案", () => {
    const mount = el();
    const app = new DslApp({ mount: mount as unknown as HTMLElement });

    expect(() => app.div({}, (() => Promise.resolve()) as never)).toThrow(/只支持同步/);
    expect(() => app.span({}, (function* () {}) as never)).toThrow(/只支持同步/);
  });
});

describe("特性：移除的节点不再被统计（不泄漏）", () => {
  it("removeSelf 之后，rerun 统计里不再有它", () => {
    const mount = el();
    const app = new DslApp({ mount: mount as unknown as HTMLElement });
    const before = allNodes().length;

    const node = app.div({ text: "x" });
    expect(allNodes().length).toBe(before + 1);

    node.removeSelf();
    expect(allNodes().length).toBe(before);
  });
});
