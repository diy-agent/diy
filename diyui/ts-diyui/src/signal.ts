/**
 * Signal<T> — 响应式状态容器
 *
 * 包装 @vue/reactivity 的 ref，对外只暴露 .value getter/setter。
 * 写操作通过 Object.is 等值判断跳过重复触发。
 * 不暴露 Ref 类型，保持框架无关的外观。
 */

import { shallowRef, type Ref } from "@vue/reactivity";

/**
 * Signal<T> — 响应式状态容器，基于 @vue/reactivity shallowRef。
 * 使用 shallowRef 而非 ref，避免 deep reactive 代理
 * （v0.1 只支持整体替换，不做 deep reactive）。
 */
export class Signal<T> {
  private _ref: Ref<T>;

  constructor(initial: T) {
    this._ref = shallowRef(initial) as Ref<T>;
  }

  get value(): T {
    return this._ref.value;
  }

  set value(v: T) {
    // Object.is 等值跳过（NaN 安全）
    if (Object.is(v, this._ref.value)) return;
    this._ref.value = v;
  }
}
