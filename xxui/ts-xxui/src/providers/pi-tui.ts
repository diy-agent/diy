/**
 * PiTuiApp — pi-tui 框架的 App 实现
 *
 * 持有 pi-tui TUI 实例，提供组件工厂方法。
 * 通过 contextStack 实现回调式构树（替代 Python 的 with 语句）。
 *
 * 参考: xxui/ts-xxui/docs/ts-xxui-design-v0.2.md §7
 */

import {
  TUI as PiTUI,
  ProcessTerminal as PiProcessTerminal,
  Text as PiText,
  Box as PiBox,
  Input as PiInput,
  Spacer as PiSpacer,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { effect } from "@vue/reactivity";
import {
  ScopeNode,
  ScopeConfig,
  type Scheduler,
  type ContextManager,
} from "../scope.js";
import { Signal } from "../signal.js";
import {
  UIComponent,
  ContainerComponent,
  LeafComponent,
} from "../components.js";
import { CellHost } from "../cell.js";
import { ImmediateScheduler } from "../scheduler.js";

// ── 基础组件实现 ──────────────────────────────────────────

/** Text 组件 — 包装 pi-tui Text */
class TsText extends LeafComponent {
  private piText: PiText;

  constructor(content: string, config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
    this.piText = new PiText(content);
    this.mountToParentPiContainer();
  }

  render(width: number): string[] {
    return this.piText.render(width);
  }

  override invalidate(): void {
    this.piText.invalidate();
  }

  setText(text: string): void {
    this.piText.setText(text);
  }
}

/** Label — 便捷文本组件，与 Text 相同实现 */
class TsLabel extends LeafComponent {
  private piText: PiText;

  constructor(content: string, config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
    this.piText = new PiText(content);
    this.mountToParentPiContainer();
  }

  render(width: number): string[] {
    return this.piText.render(width);
  }

  override invalidate(): void {
    this.piText.invalidate();
  }

  setText(text: string): void {
    this.piText.setText(text);
  }
}

/** Button — 基于 Text 的按钮样式组件（v0.1 只做样式） */
class TsButton extends LeafComponent {
  private piText: PiText;
  name: string;
  onClick?: () => void;

  constructor(name: string, config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
    this.name = name;
    this.piText = new PiText(` [${name}] `);
    this.mountToParentPiContainer();
  }

  render(width: number): string[] {
    return this.piText.render(width);
  }

  override invalidate(): void {
    this.piText.invalidate();
  }
}

/** Spacer 组件 — 包装 pi-tui Spacer */
class TsSpacer extends LeafComponent {
  private piSpacer: PiSpacer;

  constructor(lines: number = 1, config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
    this.piSpacer = new PiSpacer(lines);
    this.mountToParentPiContainer();
  }

  render(width: number): string[] {
    return this.piSpacer.render(width);
  }

  override invalidate(): void {
    this.piSpacer.invalidate();
  }

  setLines(lines: number): void {
    this.piSpacer.setLines(lines);
  }
}

/**
 * Column — 竖向容器
 * 通过自定义 children 排列来实现渲染，重写 render。
 */
class TsColumn extends ContainerComponent {
  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
  }

  /**
   * 工厂方法：创建列并推入 context 栈
   */
  static create(
    app: PiTuiApp,
    children: (ctx: TsColumn) => void,
    config?: ScopeConfig
  ): TsColumn {
    const col = new TsColumn(config, app.currentContext);
    app.pushContext(col);
    try {
      children(col);
    } finally {
      app.popContext();
    }
    return col;
  }

  /**
   * Cell 标记：将此 Column 标记为 rerun 块
   */
  cell(children: (node: TsColumn) => void): TsColumn;
  cell(children: () => void): TsColumn;
  cell(children: ((node: TsColumn) => void) | (() => void)): TsColumn {
    currentApp?.markCell(this, children as (node: ScopeNode) => void);
    return this;
  }
}

/**
 * Row — 横向容器
 * 通过自定义 render 实现平均分配宽度
 */
class TsRow extends ContainerComponent {
  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
  }

  static create(
    app: PiTuiApp,
    children: (ctx: TsRow) => void,
    config?: ScopeConfig
  ): TsRow {
    const row = new TsRow(config, app.currentContext);
    app.pushContext(row);
    try {
      children(row);
    } finally {
      app.popContext();
    }
    return row;
  }

  cell(children: (node: TsRow) => void): TsRow;
  cell(children: () => void): TsRow;
  cell(children: ((node: TsRow) => void) | (() => void)): TsRow {
    currentApp?.markCell(this, children as (node: ScopeNode) => void);
    return this;
  }

  override render(width: number): string[] {
    // 横向布局：每个子组件平分宽度
    const uiChildren = this.children.filter(
      (c) => c instanceof UIComponent
    ) as UIComponent[];

    if (uiChildren.length === 0) return [];

    const childWidth = Math.max(1, Math.floor(width / uiChildren.length));
    const childLines: string[][] = uiChildren.map((child) =>
      child.render(childWidth)
    );

    // 找出最长子组件的行数
    const maxLines = Math.max(...childLines.map((l) => l.length), 0);

    // 逐行拼接
    const result: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      let line = "";
      for (let j = 0; j < uiChildren.length; j++) {
        const childStr = i < childLines[j].length ? childLines[j][i] : "";
        line += padRight(childStr, childWidth);
      }
      result.push(line);
    }
    return result;
  }
}

/**
 * Box — 包装 pi-tui Box 容器
 *
 * 通过回调参数形式 `app.box({ x: 1, y: 2 }, (ctx) => { ... })`
 */
class TsBox extends ContainerComponent {
  private piBox: PiBox;

  constructor(config?: ScopeConfig, parent?: ScopeNode, paddingX: number = 1, paddingY: number = 1) {
    super(config, parent);
    this.piBox = new PiBox(paddingX, paddingY);
  }

  static create(
    app: PiTuiApp,
    props: { x?: number; y?: number },
    children: (ctx: TsBox) => void,
    config?: ScopeConfig
  ): TsBox {
    const box = new TsBox(config, app.currentContext, props.x, props.y);
    box.mountToParentPiContainerVia(box);
    app.pushContext(box);
    try {
      children(box);
    } finally {
      app.popContext();
    }
    // 把 children 迁移到 piBox
    for (const child of box.children) {
      if (child instanceof UIComponent) {
        box.piBox.addChild(child);
      }
    }
    return box;
  }

  private mountToParentPiContainerVia(box: TsBox): void {
    const p = this.parent;
    if (p && p instanceof ContainerComponent) {
      p.piContainer.addChild(box);
    }
  }

  override render(width: number): string[] {
    return this.piBox.render(width);
  }

  override invalidate(): void {
    this.piBox.invalidate();
  }

  // 重写 addPiChild 以委托给内部 piBox
  override addPiChild(child: UIComponent): void {
    this.piBox.addChild(child);
  }
}

/** TextInput — 包装 pi-tui Input */
class TsTextInput extends LeafComponent {
  private piInput: PiInput;

  constructor(
    opts: { value?: string; placeholder?: string; onSubmit?: (v: string) => void },
    config?: ScopeConfig,
    parent?: ScopeNode
  ) {
    super(config, parent);
    this.piInput = new PiInput();
    if (opts.value) this.piInput.setValue(opts.value);
    if (opts.onSubmit) this.piInput.onSubmit = opts.onSubmit;
    this.mountToParentPiContainer();
  }

  get value(): string {
    return this.piInput.getValue();
  }

  render(width: number): string[] {
    return this.piInput.render(width);
  }

  override handleInput(data: string): void {
    this.piInput.handleInput(data);
  }

  override invalidate(): void {
    this.piInput.invalidate();
  }
}

// ── CellHost ────────────────────────────────────────────────

// 全局 App 引用（用于 cell() 链式调用时找到 App）
let currentApp: PiTuiApp | undefined;

// ── PiTuiApp ───────────────────────────────────────────────

/**
 * PiTuiApp — pi-tui 框架的 App 入口
 *
 * 用法:
 *   import { App } from "xxui/providers/pi-tui";
 *   const app = new App({ mode: "dev", scheduler: new ImmediateScheduler() });
 *   app.column(() => {
 *     app.label("hello");
 *   });
 *   app.mount();
 *   app.run();
 */
export class PiTuiApp extends ContainerComponent implements ContextManager {
  readonly tui: PiTUI;
  readonly terminal: PiProcessTerminal;

  private contextStack: ScopeNode[] = [this];
  private cells: CellHost[] = [];
  private defaultScheduler: Scheduler;
  private isVSCodeTerminal: boolean;

  constructor(config: ScopeConfig) {
    // 根节点没有 parent
    super(config);
    // 设置全局引用供 cell() 链式调用
    currentApp = this;

    this.defaultScheduler = config.scheduler ?? new ImmediateScheduler();

    this.terminal = new PiProcessTerminal();
    this.isVSCodeTerminal = process.env.TERM_PROGRAM === "vscode";
    const useRawMode = !this.isVSCodeTerminal;
    this.tui = new PiTUI(this.terminal, useRawMode);
    // App 自己作为根组件挂入 TUI
    this.tui.addChild(this);
  }

  // ── ContextManager ───────────────────────────────────

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

  // ── PI Container 集成 ────────────────────────────────

  override render(width: number): string[] {
    return this.piContainer.render(width);
  }

  // ── 组件工厂方法 ─────────────────────────────────────

  text(content: string, config?: ScopeConfig): TsText {
    return new TsText(content, config, this.currentContext);
  }

  label(content: string, config?: ScopeConfig): TsLabel {
    return new TsLabel(content, config, this.currentContext);
  }

  button(opts: { name: string }, config?: ScopeConfig): TsButton {
    return new TsButton(opts.name, config, this.currentContext);
  }

  column(children: (ctx: TsColumn) => void, config?: ScopeConfig): TsColumn;
  column(config?: ScopeConfig): TsColumn;
  column(childrenOrConfig?: ((ctx: TsColumn) => void) | ScopeConfig, config?: ScopeConfig): TsColumn {
    if (typeof childrenOrConfig === "function") {
      return TsColumn.create(this, childrenOrConfig, config);
    }
    // 无回调：创建空容器（用于 .cell() 链式调用）
    return TsColumn.create(this, () => {}, childrenOrConfig as ScopeConfig | undefined);
  }

  row(children: (ctx: TsRow) => void, config?: ScopeConfig): TsRow;
  row(config?: ScopeConfig): TsRow;
  row(childrenOrConfig?: ((ctx: TsRow) => void) | ScopeConfig, config?: ScopeConfig): TsRow {
    if (typeof childrenOrConfig === "function") {
      return TsRow.create(this, childrenOrConfig, config);
    }
    return TsRow.create(this, () => {}, childrenOrConfig as ScopeConfig | undefined);
  }

  box(
    props: { x?: number; y?: number },
    children: (ctx: TsBox) => void,
    config?: ScopeConfig
  ): TsBox {
    return TsBox.create(this, props, children, config);
  }

  spacer(lines?: number, config?: ScopeConfig): TsSpacer {
    return new TsSpacer(lines, config, this.currentContext);
  }

  textInput(
    opts: { value?: string; placeholder?: string; onSubmit?: (v: string) => void },
    config?: ScopeConfig
  ): TsTextInput {
    return new TsTextInput(opts, config, this.currentContext);
  }

  // ── Signal ───────────────────────────────────────────

  signal<T>(initial: T): Signal<T> {
    const sig = new Signal(initial);
    this.currentContext.registerSignal(sig);
    return sig;
  }

  // ── Cell ─────────────────────────────────────────────

  /**
   * 标记 ScopeNode 为 rerun 块。
   * 使用 vue effect 自动追踪 signal 依赖。
   */
  markCell(node: ScopeNode, fn: (node: ScopeNode) => void): CellHost {
    const host = new CellHost(this, node, fn);
    this.cells.push(host);

    // 用 vue effect 包裹，cell 回调中读 signal.value 时自动建立依赖
    effect(() => {
      host.rerun();
      this.tui.requestRender();
    });

    return host;
  }

  // ── 生命周期 ─────────────────────────────────────────

  /**
   * 挂载：触发初始渲染，并将 focus 自动分配给第一个可聚焦组件
   */
  mount(): void {
    // cells 的 effect 已在 markCell 中注册，会自动渲染
    // 这里只需确保初始渲染
    this.tui.requestRender();
    // 初始 focus：找到第一个可交互组件
    this.autoFocus();
  }

  /**
   * 自动聚焦第一个可交互的叶子组件
   */
  private autoFocus(): void {
    const findFocusable = (node: ScopeNode): UIComponent | null => {
      if (
        node instanceof UIComponent &&
        "handleInput" in node &&
        typeof node.handleInput === "function"
      ) {
        return node;
      }
      for (const child of node.children) {
        const result = findFocusable(child);
        if (result) return result;
      }
      return null;
    };
    const target = findFocusable(this);
    if (target instanceof UIComponent) {
      this.tui.setFocus(target);
    }
  }

  /**
   * 注册全局输入监听器，暴露给用户
   */
  addInputListener(listener: Parameters<PiTUI["addInputListener"]>[0]): ReturnType<PiTUI["addInputListener"]> {
    return this.tui.addInputListener(listener);
  }

  /**
   * 聚焦指定组件
   */
  focus(component: UIComponent): void {
    this.tui.setFocus(component);
  }

  /**
   * 启动事件循环
   */
  run(): void {
    // 默认退出逻辑（q 或 Ctrl+C）—— 高优先级全局监听器
    this.tui.addInputListener((data: string) => {
      // Ctrl+C 或 q 退出
      if (data === "\u0003" || data.toLowerCase() === "q") {
        this.stop();
        return { consume: true };
      }
      return undefined;
    });

    this.tui.start();
  }

  /**
   * 停止 App
   */
  stop(): void {
    this.tui.stop();
    this.terminal.stop();
    process.exit(0);
  }

  override getEffectiveScheduler(): Scheduler {
    return this.defaultScheduler;
  }
}

// ── 辅助函数 ────────────────────────────────────────────────

/** 右填充字符串到指定宽度 */
function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

// ── 公共导出别名 ────────────────────────────────────────────

export { PiTuiApp as App };
