/**
 * Signal<T> — 响应式状态容器
 *
 * 基于 @vue/reactivity 的 shallowRef，对外只暴露 .value getter/setter。
 * 写操作通过 Object.is 等值判断跳过重复触发；quietSet() 可静默改值（不触发）。
 * 不暴露 Ref 类型，保持框架无关的外观。
 */

import { shallowRef, type Ref } from "@vue/reactivity";

export class Signal<T> {
  private _value: T;
  /** 版本号：读/写都经过它，用于依赖收集与触发；quietSet 不动它。 */
  private readonly _version: Ref<number>;

  constructor(initial: T) {
    this._value = initial;
    this._version = shallowRef(0) as Ref<number>;
  }

  get value(): T {
    void this._version.value; // 读取时注册依赖
    return this._value;
  }

  set value(v: T) {
    // Object.is 等值跳过（NaN 安全）
    if (Object.is(v, this._value)) return;
    this._value = v;
    this._version.value++;
  }

  /**
   * 静默写值：更新值但不触发依赖。
   * 对齐 py 的 `_reset_value`，用于按钮脉冲复位等「改值但不应重跑」的场景。
   */
  quietSet(v: T): void {
    this._value = v;
  }
}
