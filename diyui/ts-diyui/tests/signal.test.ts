/**
 * Signal 单元测试
 * 验证：等值跳过、值读写、类型正确性
 */

import { describe, it, expect, vi } from "vitest";
import { effect } from "@vue/reactivity";
import { Signal } from "../src/signal.js";

describe("Signal", () => {
  it("应该能读写基本值", () => {
    const s = new Signal(0);
    expect(s.value).toBe(0);
    s.value = 42;
    expect(s.value).toBe(42);
  });

  it("Object.is 等值应该跳过不触发变换", () => {
    const s = new Signal(0);
    const spy = vi.fn();

    effect(() => {
      void s.value; // 注册依赖
      spy();
    });
    spy.mockClear(); // 清除 effect 首次调用

    s.value = 0; // 相同值
    expect(spy).not.toHaveBeenCalled();
  });

  it("不同值应触发 effect", () => {
    const s = new Signal(0);
    const spy = vi.fn();

    effect(() => {
      void s.value;
      spy();
    });
    spy.mockClear();

    s.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("NaN 应与 NaN 等值（Object.is 语义）", () => {
    const s = new Signal(NaN);
    const spy = vi.fn();

    effect(() => {
      void s.value;
      spy();
    });
    spy.mockClear();

    s.value = NaN; // NaN === NaN is false, but Object.is(NaN, NaN) is true
    expect(spy).not.toHaveBeenCalled();
  });

  it("应支持字符串类型", () => {
    const s = new Signal("hello");
    expect(s.value).toBe("hello");
    s.value = "world";
    expect(s.value).toBe("world");
  });

  it("应支持布尔类型", () => {
    const s = new Signal(false);
    expect(s.value).toBe(false);
    s.value = true;
    expect(s.value).toBe(true);
  });

  it("应支持对象引用（浅替换）", () => {
    const obj = { count: 0 };
    const s = new Signal(obj);
    expect(s.value).toBe(obj);

    const newObj = { count: 1 };
    s.value = newObj;
    expect(s.value).toBe(newObj);
    expect(s.value.count).toBe(1);
  });

  it("Object.is 应区分不同引用但相同内容的对象", () => {
    const s = new Signal({ a: 1 });
    const spy = vi.fn();

    effect(() => {
      void s.value;
      spy();
    });
    spy.mockClear();

    s.value = { a: 1 }; // 不同引用
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("effect 应在 signal 变化时自动重新执行", () => {
    const count = new Signal(0);
    const tracked: number[] = [];

    effect(() => {
      tracked.push(count.value);
    });

    count.value = 1;
    count.value = 2;
    count.value = 2; // 跳过

    expect(tracked).toEqual([0, 1, 2]);
  });
});
