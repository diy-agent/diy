/// <reference lib="dom" />
/**
 * DomApp — 浏览器 DOM 的 App 实现（web 原型）。
 *
 * 与 providers/pi-tui.ts 同构：core（signal/scope/cell/scheduler）与框架无关，
 * 本文件只是 DOM 的薄适配层 ——
 *   - 组件 = 真实 HTMLElement（无 target 代理、无 VDOM）
 *   - cell rerun = 清空真实子节点 → 重跑 fn
 *
 * 对齐 py 的能力面（见 examples/features、examples/apps）：
 *   - 工厂方法挂在「容器」上：`app.xxx()`（挂到当前上下文）与 `node.xxx()`（挂到该节点）
 *   - cell 四种形态：sync / generator / async / async-generator（异步刷新块）
 *   - 每次 run 用独立 stage 容器 → 并发隔离；rerun 时替换 stage → 丢弃过期 async 续写
 *
 * 依赖追踪：sync cell 用 @vue/reactivity 的 effect() 自动追踪；async/generator cell
 * 追踪「首次 await/yield 之前的同步读」——TS 里 await 之后无法自动追踪（见 DESIGN 讨论）。
 */

import { effect, stop } from "@vue/reactivity";
import {
  ScopeNode,
  ScopeConfig,
  type ContextManager,
  type Scheduler,
} from "../scope.js";
import { Signal } from "../signal.js";
import { ImmediateScheduler } from "../scheduler.js";
import type { HostAdapter } from "../host.js";

// ── DOM HostAdapter（对标 py _HostCtrl） ──────────────────────

class DomHostAdapter implements HostAdapter {
  addChild(parent: unknown, child: unknown): void {
    (parent as HTMLElement).append(child as HTMLElement);
  }
  replaceChildren(host: unknown, childHosts: unknown[]): void {
    (host as HTMLElement).replaceChildren(...(childHosts as HTMLElement[]));
  }
  clearChildren(host: unknown): void {
    (host as HTMLElement).replaceChildren();
  }
}

const DOM_HOST = new DomHostAdapter();

// ── 组件基类 ────────────────────────────────────────────────

export class DomComponent extends ScopeNode {
  readonly el: HTMLElement;

  constructor(el: HTMLElement, config?: ScopeConfig, parent?: ScopeNode) {
    super(config, parent);
    this.el = el;
    this.mountToParent();
  }

  /** 创建即挂载：把自己 append 到父容器的真实元素里。 */
  protected mountToParent(): void {
    const p = this.parent;
    if (p instanceof DomContainer) p.hostEl.append(this.el);
  }

  /**
   * 从树与 DOM 中摘除自身，并**递归停止**子树的 effect。
   * 根节点（DomApp）不摘用户的挂载元素。
   */
  dispose(): void {
    if (this.parent) this.el.remove();
    super.dispose();
  }
}

/** 容器组件：可挂载子 UI，负责把 scope 树的增删同步到真实 DOM。 */
export class DomContainer extends DomComponent {
  protected hostCtrl: HostAdapter = DOM_HOST;

  /** 子节点挂载到哪个真实元素（默认就是自身）。 */
  get hostEl(): HTMLElement {
    return this.el;
  }

  /**
   * 工厂方法挂到哪个容器。
   * 普通容器 = 自身；DomApp 覆写为「当前上下文」（让 app.xxx() 跟随 with/回调块）。
   */
  protected get mountTarget(): DomContainer {
    return this;
  }

  override clearChildren(): void {
    this.hostCtrl.clearChildren(this.hostEl);
    super.clearChildren();
  }

  override replaceChildren(children: ScopeNode[]): void {
    const els = children
      .filter((c): c is DomComponent => c instanceof DomComponent)
      .map((c) => c.el);
    this.hostCtrl.replaceChildren(this.hostEl, els);
    super.replaceChildren(children);
  }

  // ── 工厂方法（node-scoped：挂到本容器） ────────────────
  text(content: string, config?: ScopeConfig): DomText {
    return new DomText(content, config, this.mountTarget);
  }
  label(content: string, config?: ScopeConfig): DomText {
    return new DomText(content, config, this.mountTarget);
  }
  button(opts: ButtonOpts, config?: ScopeConfig): DomButton {
    return new DomButton(opts, config, this.mountTarget);
  }
  input(opts: InputOpts, config?: ScopeConfig): DomInput {
    return new DomInput(opts, config, this.mountTarget);
  }
  column(fn?: ((ctx: DomColumn) => void) | ScopeConfig, config?: ScopeConfig): DomColumn {
    const target = this.mountTarget;
    if (typeof fn === "function") {
      const col = new DomColumn(config, target);
      runWithContext(this, col, () => fn(col));
      return col;
    }
    return new DomColumn(fn as ScopeConfig | undefined, target);
  }
  row(fn?: ((ctx: DomRow) => void) | ScopeConfig, config?: ScopeConfig): DomRow {
    const target = this.mountTarget;
    if (typeof fn === "function") {
      const row = new DomRow(config, target);
      runWithContext(this, row, () => fn(row));
      return row;
    }
    return new DomRow(fn as ScopeConfig | undefined, target);
  }

  // ── Signal / Cell ──────────────────────────────────────
  signal<T>(initial: T): Signal<T> {
    const sig = new Signal(initial);
    this.mountTarget.registerSignal(sig);
    return sig;
  }

  /** 标记本容器为 rerun 块。支持 sync / async / generator / async-generator。 */
  cell(fn: CellFn): this {
    const app = findApp(this);
    if (!app) throw new Error("cell(): 未找到 DomApp 根节点");
    app.registerCell(this, fn);
    return this;
  }
}

// ── 基础组件 ────────────────────────────────────────────────

export interface ButtonOpts {
  name: string;
  onClick?: () => void;
  /** sync 模式：把点击变成 Signal[bool] 脉冲（对齐 py button_sync） */
  sync?: boolean;
}
export interface InputOpts {
  value?: string;
  placeholder?: string;
  onInput?: (v: string) => void;
  onEnter?: (v: string) => void;
}

export class DomText extends DomComponent {
  constructor(content: string, config?: ScopeConfig, parent?: ScopeNode) {
    super(document.createElement("div"), config, parent);
    this.el.className = "diy-text";
    this.el.textContent = content;
  }
  setText(text: string): void {
    this.el.textContent = text;
  }
}

export class DomButton extends DomComponent {
  name: string;
  onClick?: () => void;
  /** sync 脉冲信号（仅 opts.sync 时有效） */
  readonly value: Signal<boolean>;

  constructor(opts: ButtonOpts, config?: ScopeConfig, parent?: ScopeNode) {
    super(document.createElement("button"), config, parent);
    this.el.className = "diy-button";
    this.el.setAttribute("type", "button");
    this.name = opts.name;
    this.el.textContent = opts.name;
    this.value = new Signal(false);
    if (opts.onClick) this.onClick = opts.onClick;
    this.el.addEventListener("click", () => {
      this.onClick?.();
      if (opts.sync) {
        // 脉冲：置 true 触发依赖 cell rerun；rerun 完成后静默复位
        this.value.value = true;
        queueMicrotask(() => {
          if (this.value.value) this.value.quietSet(false);
        });
      }
    });
  }
}

export class DomInput extends DomComponent {
  constructor(opts: InputOpts, config?: ScopeConfig, parent?: ScopeNode) {
    super(document.createElement("input"), config, parent);
    this.el.className = "diy-input";
    const input = this.el as HTMLInputElement;
    if (opts.value != null) input.value = opts.value;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.onInput) input.addEventListener("input", () => opts.onInput!(input.value));
    if (opts.onEnter) {
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") opts.onEnter!(input.value);
      });
    }
  }
  get value(): string {
    return (this.el as HTMLInputElement).value;
  }
  set value(v: string) {
    (this.el as HTMLInputElement).value = v;
  }
}

export class DomColumn extends DomContainer {
  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(document.createElement("div"), config, parent);
    this.el.className = "diy-column";
  }
}

export class DomRow extends DomContainer {
  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    super(document.createElement("div"), config, parent);
    this.el.className = "diy-row";
  }
}

// ── Cell 运行时 ─────────────────────────────────────────────

export type CellFn = (node: DomContainer) => unknown;
type CellKind = "sync" | "async" | "generator" | "async-generator";

function cellKind(fn: CellFn): CellKind {
  const name = (fn as { constructor?: { name?: string } }).constructor?.name;
  if (name === "AsyncGeneratorFunction") return "async-generator";
  if (name === "GeneratorFunction") return "generator";
  if (name === "AsyncFunction") return "async";
  return "sync";
}

/**
 * CellBinding — 一次 cell 的运行时。
 *
 * 每次 run：丢弃旧 stage → 建新 stage → 把 fn 的产出挂进 stage。
 * stage 隔离保证「同一 cell 的过期 async 续写」写进已被移除的节点，不可见。
 */
class CellBinding {
  private stage?: DomContainer;
  private epoch = 0;

  constructor(
    private readonly app: DomApp,
    private readonly node: DomContainer,
    private readonly fn: CellFn,
  ) {}

  run(): void {
    const epoch = ++this.epoch;

    // 新一轮先**离屏**构建 stage：逻辑上已接父（app 查找依赖 parent 链），但 DOM 暂不挂；
    // 成功才替换旧的 → 抛错时界面保留上一次成功的内容
    const stage = new DomColumn(undefined, undefined);
    stage.parent = this.node;
    this.node.children.push(stage);

    // cell 里用 app.xxx() 时挂到本 stage —— 否则会落到根节点（内容和 cell 不同步）
    this.app.pushContext(stage);
    try {
      switch (cellKind(this.fn)) {
        case "sync":
          this.fn(stage);
          break;
        case "generator":
          for (const _ of this.fn(stage) as Generator<unknown>) void _;
          break;
        case "async":
          void Promise.resolve(this.fn(stage) as Promise<void>).catch((e) =>
            this.onError(epoch, e),
          );
          break;
        case "async-generator":
          void this.driveAsync(epoch, this.fn(stage) as AsyncGenerator<unknown>);
          break;
      }
    } catch (e) {
      stage.dispose(); // 半成品丢弃，旧 stage 原样保留
      this.onError(epoch, e);
      return;
    } finally {
      this.app.popContext();
    }

    // 上台：先丢弃上一轮（过期 async 续写随之不可见；子树 effect 一起停），再挂新的
    this.stage?.dispose();
    this.node.hostEl.append(stage.el);
    this.stage = stage;
  }

  private async driveAsync(epoch: number, gen: AsyncGenerator<unknown>): Promise<void> {
    try {
      for await (const _ of gen) {
        if (epoch !== this.epoch) return; // 被新一次 run 取代，停止驱动
        void _;
      }
    } catch (e) {
      this.onError(epoch, e);
    }
  }

  private onError(epoch: number, e: unknown): void {
    if (epoch !== this.epoch) return;
    console.error("[diy-ui] cell error", e);
  }
}

// ── DomApp ──────────────────────────────────────────────────

export interface DomAppOptions {
  mount: string | HTMLElement;
  mode?: "dev" | "prod";
  scheduler?: Scheduler;
}

export class DomApp extends DomContainer implements ContextManager {
  readonly root: HTMLElement;
  private contextStack: ScopeNode[];
  private defaultScheduler: Scheduler;

  constructor(opts: DomAppOptions) {
    const root =
      typeof opts.mount === "string"
        ? document.querySelector<HTMLElement>(opts.mount)
        : opts.mount;
    if (!root) throw new Error(`DomApp: 挂载点未找到: ${String(opts.mount)}`);
    super(
      root,
      new ScopeConfig({ mode: opts.mode ?? "dev", scheduler: opts.scheduler }),
      undefined,
    );
    this.root = root;
    this.contextStack = [this];
    this.defaultScheduler = opts.scheduler ?? new ImmediateScheduler();
  }

  /** app.xxx() 挂到「当前上下文」而非根。 */
  protected override get mountTarget(): DomContainer {
    const ctx = this.currentContext;
    return ctx instanceof DomContainer ? ctx : this;
  }

  // ── ContextManager ─────────────────────────────────────
  get currentContext(): ScopeNode {
    return this.contextStack[this.contextStack.length - 1];
  }
  pushContext(node: ScopeNode): void {
    this.contextStack.push(node);
  }
  popContext(): void {
    if (this.contextStack.length > 1) this.contextStack.pop();
  }

  // ── Cell 注册 ──────────────────────────────────────────
  /**
   * 用 vue effect 驱动 CellBinding。
   * effect 首次执行时同步跑 fn 的「前缀段」→ 首段读取的 signal 自动成为依赖；
   * 依赖变化 → effect 重跑 → binding.run()（旧 stage 丢弃，新 stage 重建）。
   *
   * TODO(M3): 记录并 stop 嵌套 cell 的子 effect，避免 stage 被丢弃后泄漏。
   */
  registerCell(node: ScopeNode, fn: CellFn): void {
    if (!(node instanceof DomContainer)) {
      throw new Error("cell(): 只能标记在 DomContainer 上");
    }
    const binding = new CellBinding(this, node, fn);
    const runner = effect(() => {
      binding.run();
    });
    // effect 随节点销毁一起停：否则节点移除后信号变化仍会重跑（往已脱离文档的 stage 里写）
    node.onDispose(() => stop(runner));
  }

  // ── 生命周期 ───────────────────────────────────────────
  /** DOM 实时更新，无需显式渲染；保留以对齐 API。 */
  mount(): void {
    /* no-op */
  }
  run(): void {
    /* 事件循环由浏览器提供 */
  }

  override getEffectiveScheduler(): Scheduler {
    return this.defaultScheduler;
  }
}

// ── 工具 ────────────────────────────────────────────────────

/** 沿 parent 链找到 DomApp 根节点。 */
function findApp(node: ScopeNode): DomApp | undefined {
  let n: ScopeNode | undefined = node;
  while (n) {
    if (n instanceof DomApp) return n;
    n = n.parent;
  }
  return undefined;
}

/** 在 app 的上下文栈上包裹一次同步建树（用于 column/row 的回调）。 */
function runWithContext(owner: DomContainer, child: ScopeNode, body: () => void): void {
  const app = findApp(owner);
  if (!app) {
    body();
    return;
  }
  app.pushContext(child);
  try {
    body();
  } finally {
    app.popContext();
  }
}
