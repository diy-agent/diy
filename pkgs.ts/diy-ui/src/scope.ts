/**
 * ScopeNode + ScopeConfig — 树形运行时配置节点
 *
 * 组件树同时也是运行时配置树（mode、maxRerunDepth 等）。
 * 配置向上查找：子节点未设置时继承父节点的配置。
 */

import type { Signal } from "./signal.js";

/**
 * Context 管理器接口 — 由 App 实现
 * 所有通过 app.xxx() 创建的组件需要访问 currentContext 来正确挂载
 */
export interface ContextManager {
  /** 当前活跃的上下文节点（栈顶） */
  readonly currentContext: ScopeNode;
  /** 推入一个新上下文（容器创建时） */
  pushContext(node: ScopeNode): void;
  /** 弹出当前上下文 */
  popContext(): void;
}

// ── ScopeConfig ───────────────────────────────────────────

export class ScopeConfig {
  /** dev 模式开启 scope violation 检查（signal 越界访问警告） */
  mode?: "dev" | "prod";
  /** cell rerun 最大嵌套深度，默认 100 */
  maxRerunDepth?: number;

  constructor(opts?: Partial<ScopeConfig>) {
    if (opts) {
      if (opts.mode !== undefined) this.mode = opts.mode;
      if (opts.maxRerunDepth !== undefined)
        this.maxRerunDepth = opts.maxRerunDepth;
    }
  }
}

// ── ScopeNode ─────────────────────────────────────────────

export class ScopeNode {
  /** 父节点 */
  parent?: ScopeNode;
  /** 子节点列表 */
  children: ScopeNode[] = [];
  /** 当前节点的运行时配置 */
  config?: ScopeConfig;
  /** 当前节点注册的 signal（用于 scope violation 检测） */
  private _signals: Set<Signal<unknown>> = new Set();
  /** 随本节点销毁的回调（effect 停止 / 定时器 / 事件监听）。 */
  private _disposers: Array<() => void> = [];
  /** 是否已销毁（重复 dispose 幂等）。 */
  private _disposed = false;

  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    this.config = config;
    if (parent) {
      this.parent = parent;
      parent.children.push(this);
    }
  }

  // ── 生命周期（销毁 = 停副作用 + 递归子节点 + 摘树） ──────

  /** 是否已销毁。 */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * 登记随本节点销毁的回调（effect 停止 / 事件监听 / 定时器）。
   *
   * 节点的副作用**必须**走这里：否则节点被移除后 effect 仍订阅信号，
   * 会继续往已经不在文档里的节点写（实测：dispose 后信号变化仍重跑）。
   */
  onDispose(fn: () => void): void {
    if (this._disposed) {
      fn(); // 已销毁：立刻执行，避免静默泄漏
      return;
    }
    this._disposers.push(fn);
  }

  /**
   * 销毁本节点：停掉登记的回调 → **递归**销毁子节点 → 从父节点摘下。幂等。
   *
   * 递归是必须的：cell 的 stage 是一棵子树，只销毁根会留下子节点里
   * 注册的 effect（实测：嵌套 cell 每次外层重跑累积一个幽灵订阅）。
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = this._disposers.length - 1; i >= 0; i--) this._disposers[i]();
    this._disposers.length = 0;
    for (const child of [...this.children]) child.dispose();
    this.children.length = 0;
    this._signals.clear();
    if (this.parent) this.parent.removeChild(this);
    this.parent = undefined;
  }

  // ── 配置查找（向上冒泡） ──────────────────────────────

  /** 获取最近祖先的有效 mode */
  getEffectiveMode(): "dev" | "prod" {
    if (this.config?.mode) return this.config.mode;
    if (this.parent) return this.parent.getEffectiveMode();
    return "dev"; // 默认 dev
  }

  /** 获取最近祖先的有效 maxRerunDepth */
  getEffectiveMaxRerunDepth(): number {
    if (this.config?.maxRerunDepth !== undefined)
      return this.config.maxRerunDepth;
    if (this.parent) return this.parent.getEffectiveMaxRerunDepth();
    return 100; // 默认 100
  }

  // ── children 管理 ──────────────────────────────────────

  /** 清空所有子节点 */
  clearChildren(): void {
    this.children = [];
  }

  /** 替换子节点（用于 cell rerun 失败回滚） */
  replaceChildren(newChildren: ScopeNode[]): void {
    this.children = newChildren;
  }

  /** 移除指定子节点 */
  removeChild(child: ScopeNode): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
    }
  }

  // ── signal 注册 ────────────────────────────────────────

  /** 在此 scope 注册一个 signal */
  registerSignal(sig: Signal<unknown>): void {
    this._signals.add(sig);
  }

  /** 检查 signal 是否在此 scope 或子树中注册（用于 scope violation 检测） */
  ownsSignal(sig: Signal<unknown>): boolean {
    return this._signals.has(sig);
  }

  /** 在子树中递归查找 signal 的拥有者 */
  findSignalOwner(sig: Signal<unknown>): ScopeNode | null {
    if (this._signals.has(sig)) return this;
    for (const child of this.children) {
      const owner = child.findSignalOwner(sig);
      if (owner) return owner;
    }
    return null;
  }

  // ── 树遍历 ────────────────────────────────────────────

  /** 树的深度 */
  get depth(): number {
    let d = 0;
    let node: ScopeNode | undefined = this.parent;
    while (node) {
      d++;
      node = node.parent;
    }
    return d;
  }
}
