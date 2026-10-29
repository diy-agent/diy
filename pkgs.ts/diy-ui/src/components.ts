/**
 * UIComponent — diyui.ts 组件基类
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
   * 将自己挂载到父 ScopeNode 的原生容器中。
   *
   * 走 `addPiChild` 而不是直接 `p.piContainer.addChild(this)`：子类可以决定
   * 「原生容器」是哪个（TsBox 的容器是内部 `piBox`，不是 `piContainer`）。
   */
  protected mountToParentPiContainer(): void {
    const p = this.parent;
    if (p instanceof ContainerComponent) {
      p.addPiChild(this);
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
    // 将自己挂到父的容器
    this.mountToParentPiContainer();
  }

  /**
   * 子组件的**原生容器**：默认就是 `piContainer`。
   * 包装型容器（如 TsBox）覆写成内部容器，`addPiChild/removePiChild/render` 都会跟着走。
   */
  protected get nativeContainer(): PiContainer {
    return this.piContainer;
  }

  render(width: number): string[] {
    // 默认：让原生 Container 渲染
    return this.nativeContainer.render(width);
  }

  override invalidate(): void {
    this.nativeContainer.invalidate();
  }

  /** 将 ScopeNode child 添加到原生容器 */
  addPiChild(child: UIComponent): void {
    this.nativeContainer.addChild(child);
  }

  /** 从原生容器移除 */
  removePiChild(child: UIComponent): void {
    this.nativeContainer.removeChild(child);
  }

  /** 清空原生容器 */
  clearPiChildren(): void {
    this.nativeContainer.clear();
  }

  /** 移除子节点：逻辑树与原生渲染**一起**摘（否则移除后仍在渲染）。 */
  override removeChild(child: ScopeNode): void {
    super.removeChild(child);
    if (child instanceof UIComponent) this.nativeContainer.removeChild(child);
  }

  /** 全量替换：逻辑树与原生渲染保持一致（cell 失败回滚也走这里）。 */
  override replaceChildren(children: ScopeNode[]): void {
    super.replaceChildren(children);
    this.nativeContainer.clear();
    for (const c of children) {
      if (c instanceof UIComponent) this.nativeContainer.addChild(c);
    }
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
