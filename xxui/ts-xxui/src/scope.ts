/**
 * ScopeNode + ScopeConfig — 树形运行时配置节点
 *
 * 组件树同时也是运行时配置树（scheduler、mode、maxRerunDepth 等）。
 * 配置向上查找：子节点未设置时继承父节点的配置。
 */

import type { Signal } from "./signal.js";

// ── Scheduler 接口（前向声明，实现在 scheduler.ts） ───────

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

export interface Scheduler {
  /** 标记 cell 为脏，等待 rerun */
  schedule(cell: unknown): void;
  /** 立即处理所有挂起的 rerun */
  flush(): void;
}

// ── ScopeConfig ───────────────────────────────────────────

export class ScopeConfig {
  /** dev 模式开启 scope violation 检查（signal 越界访问警告） */
  mode?: "dev" | "prod";
  /** rerun 调度策略 */
  scheduler?: Scheduler;
  /** cell rerun 最大嵌套深度，默认 100 */
  maxRerunDepth?: number;

  constructor(opts?: Partial<ScopeConfig>) {
    if (opts) {
      if (opts.mode !== undefined) this.mode = opts.mode;
      if (opts.scheduler !== undefined) this.scheduler = opts.scheduler;
      if (opts.maxRerunDepth !== undefined) this.maxRerunDepth = opts.maxRerunDepth;
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

  constructor(config?: ScopeConfig, parent?: ScopeNode) {
    this.config = config;
    if (parent) {
      this.parent = parent;
      parent.children.push(this);
    }
  }

  // ── 配置查找（向上冒泡） ──────────────────────────────

  /** 获取最近祖先的有效 scheduler */
  getEffectiveScheduler(): Scheduler {
    if (this.config?.scheduler) return this.config.scheduler;
    if (this.parent) return this.parent.getEffectiveScheduler();
    // 根节点没有 scheduler 时应有默认实现
    throw new Error("No scheduler configured. App root must provide a default Scheduler.");
  }

  /** 获取最近祖先的有效 mode */
  getEffectiveMode(): "dev" | "prod" {
    if (this.config?.mode) return this.config.mode;
    if (this.parent) return this.parent.getEffectiveMode();
    return "dev"; // 默认 dev
  }

  /** 获取最近祖先的有效 maxRerunDepth */
  getEffectiveMaxRerunDepth(): number {
    if (this.config?.maxRerunDepth !== undefined) return this.config.maxRerunDepth;
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
