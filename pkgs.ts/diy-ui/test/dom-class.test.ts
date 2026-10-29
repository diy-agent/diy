/**
 * `class` 分段组合（数组形态）单元测试 —— 唯一的「原子变更」语法。
 *
 * 无 DOM 环境：用只实现 setAttribute / removeAttribute 的假元素。
 * 断言重点是「读全部段 → 拼一次 → 写一次」（原子），以及 falsy 段跳过、不去重。
 */

import { describe, it, expect } from "vitest";
import { Signal } from "../src/signal.js";
import { applyProps, type Props } from "../src/providers/dom-dsl.js";

class FakeEl {
  textContent = "";
  attrs: Record<string, string> = {};
  /** setAttribute 的调用次数（验证「一次写入」）。 */
  writes = 0;

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    this.writes++;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
    this.writes++;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  remove(): void {}

  get cls(): string | undefined {
    return this.attrs.class;
  }
}

const mk = (): [FakeEl, HTMLElement] => {
  const el = new FakeEl();
  return [el, el as unknown as HTMLElement];
};

const bind = (el: FakeEl, host: HTMLElement, props: Props): void => {
  applyProps(host, props);
};

describe("class 数组：静态串 + Signal / getter 混写", () => {
  it("静态串与 Signal 段拼在一起，信号变 → 整体重算", () => {
    const [el, host] = mk();
    const size = new Signal("text-sm");
    bind(el, host, { class: ["flex items-baseline gap-2", size] });
    expect(el.cls).toBe("flex items-baseline gap-2 text-sm");

    size.value = "text-lg";
    expect(el.cls).toBe("flex items-baseline gap-2 text-lg");
  });

  it("getter 段按条件拼接，falsy 跳过", () => {
    const [el, host] = mk();
    const active = new Signal(false);
    bind(el, host, { class: ["btn", () => active.value && "is-active"] });
    expect(el.cls).toBe("btn");

    active.value = true;
    expect(el.cls).toBe("btn is-active");
  });

  it("falsy 段（false / null / undefined / 空串）都不参与拼接", () => {
    const [el, host] = mk();
    bind(el, host, { class: ["a", false, null, undefined, "", "b"] });
    expect(el.cls).toBe("a b");
  });

  it("不去重：同样的类名写两段就出现两次", () => {
    const [el, host] = mk();
    bind(el, host, { class: ["btn", "btn"] });
    expect(el.cls).toBe("btn btn");
  });

  it("空数组 / 全 falsy → 移除 class 属性", () => {
    const [el, host] = mk();
    bind(el, host, { class: [] });
    expect(el.cls).toBeUndefined();
  });
});

describe("class 数组：原子（只写一次）", () => {
  it("全静态段：建结构时只写一次", () => {
    const [el, host] = mk();
    bind(el, host, { class: ["a", "b", "c"] });
    expect(el.writes).toBe(1);
    expect(el.cls).toBe("a b c");
  });

  it("含响应式段：每次信号变化只写一次", () => {
    const [el, host] = mk();
    const a = new Signal("x");
    const b = new Signal("y");
    bind(el, host, { class: [a, b] });
    expect(el.cls).toBe("x y");
    expect(el.writes).toBe(1);

    a.value = "x2";
    expect(el.cls).toBe("x2 y");
    expect(el.writes).toBe(2); // 一次信号变化 = 一次写入

    b.value = "y2";
    expect(el.cls).toBe("x2 y2");
    expect(el.writes).toBe(3);
  });
});

describe("class 原有形态不受影响（回归）", () => {
  it("整体 getter", () => {
    const [el, host] = mk();
    const on = new Signal(false);
    bind(el, host, { class: () => (on.value ? "on" : "off") });
    expect(el.cls).toBe("off");
    on.value = true;
    expect(el.cls).toBe("on");
  });

  it("整体 Signal", () => {
    const [el, host] = mk();
    const cls = new Signal("a");
    bind(el, host, { class: cls });
    expect(el.cls).toBe("a");
    cls.value = "b";
    expect(el.cls).toBe("b");
  });

  it("静态字符串", () => {
    const [el, host] = mk();
    bind(el, host, { class: "solo" });
    expect(el.cls).toBe("solo");
  });
});
