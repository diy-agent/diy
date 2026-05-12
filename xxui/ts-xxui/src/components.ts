/**
 * UIComponent — ts-xxui 组件基类
 *
 * 同时继承 ScopeNode 和实现 pi-tui Component 接口。
 * 不通过 target 代理，直接就是 pi-tui Component。
 */

import type { Component } from "@mariozechner/pi-tui";
import { Container as PiContainer } from "@mariozechner/pi-tui";
import { ScopeNode, ScopeConfig } from "./scope.js";

/**
 * UIComponent 基类
 *
 * 同时是 ScopeNode 和 pi-tui Component。
 * 子类必须实现 render(width)。
 */
export abstract class UIComponent extends ScopeNode implements Component {
  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
  }

  abstract render(width: number): string[];

  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;

  invalidate(): void {
    // 默认实现：子类可覆盖
  }

  /**
   * 将自己挂载到父 ScopeNode 的 pi-tui children 中。
   * 父节点必须是 ContainerComponent（有 piContainer）。
   */
  protected mountToParentPiContainer(): void {
    const p = this.parent;
    if (p && p instanceof ContainerComponent) {
      p.piContainer.addChild(this);
    }
    // 如果是 App 根节点或其他特殊父节点，mount() 时处理
  }
}

/**
 * ContainerComponent — 可挂载子 UI 的容器
 *
 * 内部持有 pi-tui Container 实例，管理子组件的渲染。
 */
export abstract class ContainerComponent extends UIComponent {
  /** pi-tui Container 实例（直接集成） */
  readonly piContainer: PiContainer;

  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
    this.piContainer = new PiContainer();
    // 将自己挂到父的 piContainer
    this.mountToParentPiContainer();
  }

  render(width: number): string[] {
    // 默认：让 pi-tui Container 渲染
    return this.piContainer.render(width);
  }

  override invalidate(): void {
    this.piContainer.invalidate();
  }

  /** 将 ScopeNode child 添加到 piContainer */
  addPiChild(child: UIComponent): void {
    this.piContainer.addChild(child);
  }

  /** 从 piContainer 移除 */
  removePiChild(child: UIComponent): void {
    this.piContainer.removeChild(child);
  }

  /** 清空 piContainer */
  clearPiChildren(): void {
    this.piContainer.clear();
  }

  override clearChildren(): void {
    this.clearPiChildren();
    super.clearChildren();
  }
}

/**
 * LeafComponent — 不可挂载子 UI 的叶子组件
 */
export abstract class LeafComponent extends UIComponent {
  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
  }
}
