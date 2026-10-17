/**
 * dom-dsl — DOM provider 的**纯 TS 声明式层**（不打 JSX）。
 *
 * 为什么需要它：providers/dom.ts 只给命令式工厂（`app.column()` / `node.row()`），
 * 建出来的节点没有「属性/结构」的声明入口，样式只能 `el.classList.add(...)`，
 * 于是 `el` 泄漏到业务代码里。
 *
 * 本层把「元素树」表达成一串 **tag 工厂调用 + 尾部 children 函数**，一次性实例化
 * 成真实 DOM（不做 diff），并对齐框架其余部分的响应式：
 *
 *   - 结构：`d.div({ class: "turn" }, (turn) => { turn.span(...) })`
 *     —— 所有普通属性（含文本 `text`）走一个 props 对象；尾部函数收到**本节点**。
 *   - 细粒度绑定：props 值可以是 `Signal` 或 getter（`value: inputText`），
 *     只 patch 那一个属性/文本，用 `effect` 驱动。
 *   - 重跑块：**尾部函数本身就是重跑块** —— 它在 `effect` 里跑，读到信号就订阅，
 *     信号变就「清空本轮子节点 → 重新组装」。没读信号 = 只跑一次（静态）。
 *     因此不再需要单独的 `cell()`。
 *   - 作用域释放：每次重跑会 dispose 上一轮子树的全部 effect，避免泄漏。
 *   - 逃生口：`d.el`（仅在必须直操作 DOM 时用，如滚动定位）。
 *
 * 文本 vs 子节点二选一：`text: "…"` 是叶子文本；要子节点就用尾部函数。同时给会报错。
 *
 * 异步重跑块：尾部函数可以是 async/generator。**依赖必须提前读**（同步前缀）——
 * await/yield 之后读的信号不会被自动追踪（TS 无法跨挂起追踪）。
 */

import { effect, stop } from "@vue/reactivity";
import { Signal } from "../signal.js";

// ── 类型 ────────────────────────────────────────────────────

/** 普通值 / Signal / getter，三者写法一致。 */
export type Reactive<T> = T | Signal<T> | (() => T);
export type ClassValue = string | null | undefined | false;
export type StyleValue = string | Partial<CSSStyleDeclaration>;

/**
 * 元素 props。故意留字符串索引签名 —— 未列出的键运行时会走 `bindAttr`，
 * 所以任意 HTML 属性（含 `data-*` / `aria-*`）都能直接写。
 */
export interface Props {
  class?: Reactive<ClassValue>;
  style?: Reactive<StyleValue>;
  /**
   * 行级增量：身份令牌（任何 `===` 可比的）。同一父块里，同 key 的上一轮子节点会被
   * **复用**而非重建；推荐直接给 item 对象（不可变数据下「同对象=没变」）。
   * 不落 DOM。
   */
  key?: unknown;
  /** 行级增量：变更令牌。给了就「同 key 但 rev 变 → 只重建这一行」；不给则同 key 一律复用。 */
  rev?: unknown;
  /** 逃生口：拿到本元素真实节点（仅必须直操作 DOM 时用，如滚动）。 */
  ref?: (el: HTMLElement) => void;
  /** 叶子文本（唯一的文本入口）。不要与尾部函数同时用。 */
  text?: Reactive<string | number | null | undefined | false>;
  value?: Reactive<string | number>;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  type?: string;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** 便捷：Enter 触发（内部监听 keydown + key === "Enter"）。 */
  onEnter?: (e: KeyboardEvent) => void;
  [attr: string]: unknown;
}

/** 尾部 children 组装函数：收到本节点；在 effect 里运行 → 读到信号就会重跑。 */
export type Build = (self: El) => void;
/** 组件：纯函数 `(父节点, 载荷) => void`。 */
export type Comp = (self: El, payload: unknown) => void;
type Disposer = () => void;

// ── 作用域（可释放的副作用集合） ────────────────────────────

const scopeStack: Disposer[][] = [];
let rootScope: Disposer[] = [];

function currentScope(): Disposer[] {
  return scopeStack[scopeStack.length - 1] ?? rootScope;
}
export function pushScope(): Disposer[] {
  const s: Disposer[] = [];
  scopeStack.push(s);
  return s;
}
export function popScope(): void {
  scopeStack.pop();
}
export function addDisposer(d: Disposer): void {
  currentScope().push(d);
}
export function disposeAll(list: Disposer[]): void {
  for (let i = list.length - 1; i >= 0; i--) list[i]();
  list.length = 0;
}

/**
 * 建一个自动追踪 effect，并把「停止它」登记进当前作用域。
 *
 * ⚠️ `effect()` 返回的是**可调用的 Runner**：直接 `disposeAll` 里 `runner()` 会
 * 把 effect 重跑一遍（不是停止）。必须用 `stop(runner)`。
 */
export function autoEffect(fn: () => void): void {
  const runner = effect(fn);
  addDisposer(() => stop(runner));
}

// ── keyed 对账（行级增量） ──────────────────────────────────

/** 一个被 keyed 对账管理的直接子节点。 */
export interface KeyedChild<H> {
  el: HTMLElement;
  handle: H;
  rev: unknown;
  /** 该子树的独立作用域（props 副作用 + 其重跑块）；移除/重建时释放。 */
  scope: Disposer[];
}

/**
 * 块重跑时的 keyed 对账：同 key 复用上一轮子节点，只动差量。
 *
 * - `reuse(key, rev)`：同 key 且 rev 未变 → 复用（调用方跳过重建 + 保留其作用域）；
 * - `put(...)`：登记新建条目；`keep(...)`：登记复用条目；
 * - `prune()`：上一轮没被本轮引用的条目 → 释放作用域 + 移除 DOM；
 * - `reorder(container)`：按登记顺序校正 DOM（只在错位时移动 → 追加场景零移动）。
 */
export class Reconciler<H extends { el: HTMLElement }> {
  readonly next = new Map<unknown, KeyedChild<H>>();
  private readonly prev: Map<unknown, KeyedChild<H>>;

  constructor(prev?: Map<unknown, KeyedChild<H>>) {
    this.prev = prev ?? new Map();
  }

  reuse(key: unknown, rev: unknown): KeyedChild<H> | undefined {
    const old = this.prev.get(key);
    return old && old.rev === rev ? old : undefined;
  }

  keep(key: unknown, entry: KeyedChild<H>): void {
    this.next.set(key, entry);
  }

  put(key: unknown, rev: unknown, handle: H, scope: Disposer[]): void {
    this.next.set(key, { el: handle.el, handle, rev, scope });
  }

  prune(): void {
    for (const [key, old] of this.prev) {
      if (this.next.get(key) !== old) {
        disposeAll(old.scope);
        old.el.remove();
      }
    }
  }

  reorder(container: HTMLElement): void {
    let cursor: ChildNode | null = null;
    for (const e of this.next.values()) {
      const want: ChildNode | null = cursor ? cursor.nextSibling : container.firstChild;
      if (e.el !== want) container.insertBefore(e.el, want);
      cursor = e.el;
    }
  }
}

/** 当前块的对账上下文（块重跑期间有效；createEl 用它判断「是不是本块的直接子节点」）。 */
interface ReconcileCtx {
  parent: El;
  rec: Reconciler<El>;
}
const reconcileStack: ReconcileCtx[] = [];

// ── 环境节点栈（ambient：让 `app.xxx()` 跟随当前组装节点） ──

const nodeStack: El[] = [];

/** 被追踪的节点（rerun 计数用）。 */
export interface TrackedNode {
  el: HTMLElement;
  reruns: number;
  /** 是否为重跑块（有尾部函数/子生成器）；静态叶子为 false。 */
  rerunCell?: boolean;
  /** 定义处（file:line，dev 诊断用；best-effort）。 */
  loc?: string;
}

/** 所有创建过的节点（dev：rerun 计数快照用；不回收，仅调试）。 */
export const allNodes = new Set<TrackedNode>();

/** 元素 → 节点 反查（dev：悬浮查看某元素 rerun 次数）。 */
const nodeByEl = new WeakMap<HTMLElement, TrackedNode>();

/** 登记节点到 rerun 统计。 */
export function trackNode(n: TrackedNode): void {
  allNodes.add(n);
  nodeByEl.set(n.el, n);
}

/** 某真实元素对应的节点（未登记则 undefined）。 */
export function nodeOf(el: HTMLElement): TrackedNode | undefined {
  return nodeByEl.get(el);
}

/** 某真实元素对应的节点 rerun 次数（未登记则 undefined）。 */
export function rerunsOf(el: HTMLElement): number | undefined {
  return nodeByEl.get(el)?.reruns;
}

/** 采集调用点（file:line），跳过本层运行时帧；best-effort。 */
let captureLocOn = false;

/** 是否采集 loc（默认关；devtools 装的时候打开，避免正常构建付栈采集成本）。 */
export function setCaptureLoc(on: boolean): void {
  captureLocOn = on;
}

export function captureLoc(): string {
  if (!captureLocOn) return "—";
  const stack = (new Error().stack ?? "").split("\n").slice(2);
  for (const line of stack) {
    if (/dom-dsl|dom-gen|devtools|@vue|node_modules|vite|dist\//.test(line)) continue;
    const m = line.match(/([^/\\()\s]+):(\d+):(\d+)\)?\s*$/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return "—";
}

/** 跑过不止一次的节点（dev 排查异常 rerun）。 */
export function dumpReruns(): Array<{ el: HTMLElement; reruns: number }> {
  const out: Array<{ el: HTMLElement; reruns: number }> = [];
  for (const n of allNodes) if (n.reruns > 1) out.push({ el: n.el, reruns: n.reruns });
  return out;
}

/** rerun 计数分布（dev 排查异常 rerun）。 */
export function computeRerunStats(): {
  nodes: number;
  rerun: number;
  max: number;
  histogram: Record<string, number>;
} {
  let rerun = 0;
  let max = 0;
  const histogram: Record<string, number> = {};
  for (const n of allNodes) {
    const k = String(n.reruns);
    histogram[k] = (histogram[k] ?? 0) + 1;
    if (n.reruns > 1) rerun++;
    if (n.reruns > max) max = n.reruns;
  }
  return { nodes: allNodes.size, rerun, max, histogram };
}

/** 当前组装节点（ambient），没有则为 undefined。 */
export function ambientNode(): El | undefined {
  return nodeStack[nodeStack.length - 1];
}

// ── El：元素句柄 + tag 工厂 ─────────────────────────────────

export class El {
  readonly el: HTMLElement;
  app!: DslApp;
  /** 本节点尾部函数被运行的次数（首跑=1）；dev 用，看异常 rerun。 */
  reruns = 0;
  /** 是否重跑块（有尾部函数）；静态叶子为 false。 */
  rerunCell = false;
  /** 定义处（file:line，dev 诊断用）。 */
  loc?: string;
  /** 本元素上一轮的 keyed 直接子节点（行级增量对账用）。 */
  keyedChildren?: Map<unknown, KeyedChild<El>>;
  /** 自身作用域（props 副作用 + `.unsafe` 块 + 子节点注册）；`removeSelf()` 时释放。 */
  ownScope?: Disposer[];

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** 工厂把子节点挂到哪个节点：普通节点=自身；DslApp 覆写为「环境节点」。 */
  protected get host(): El {
    return this;
  }

  private mk(tag: string, props?: Props, build?: Build): El {
    return createEl(this.host, tag, props, build);
  }

  // ── tag 工厂（纯 TS，无 JSX） ──
  div(props?: Props, build?: Build): El { return this.mk("div", props, build); }
  span(props?: Props, build?: Build): El { return this.mk("span", props, build); }
  p(props?: Props, build?: Build): El { return this.mk("p", props, build); }
  a(props?: Props, build?: Build): El { return this.mk("a", props, build); }
  button(props?: Props, build?: Build): El { return this.mk("button", props, build); }
  input(props?: Props, build?: Build): El { return this.mk("input", props, build); }
  textarea(props?: Props, build?: Build): El { return this.mk("textarea", props, build); }
  label(props?: Props, build?: Build): El { return this.mk("label", props, build); }
  img(props?: Props, build?: Build): El { return this.mk("img", props, build); }
  ul(props?: Props, build?: Build): El { return this.mk("ul", props, build); }
  ol(props?: Props, build?: Build): El { return this.mk("ol", props, build); }
  li(props?: Props, build?: Build): El { return this.mk("li", props, build); }
  h1(props?: Props, build?: Build): El { return this.mk("h1", props, build); }
  h2(props?: Props, build?: Build): El { return this.mk("h2", props, build); }
  h3(props?: Props, build?: Build): El { return this.mk("h3", props, build); }
  h4(props?: Props, build?: Build): El { return this.mk("h4", props, build); }
  section(props?: Props, build?: Build): El { return this.mk("section", props, build); }
  header(props?: Props, build?: Build): El { return this.mk("header", props, build); }
  footer(props?: Props, build?: Build): El { return this.mk("footer", props, build); }
  main(props?: Props, build?: Build): El { return this.mk("main", props, build); }
  pre(props?: Props, build?: Build): El { return this.mk("pre", props, build); }
  code(props?: Props, build?: Build): El { return this.mk("code", props, build); }
  strong(props?: Props, build?: Build): El { return this.mk("strong", props, build); }
  em(props?: Props, build?: Build): El { return this.mk("em", props, build); }
  small(props?: Props, build?: Build): El { return this.mk("small", props, build); }
  br(props?: Props, build?: Build): El { return this.mk("br", props, build); }
  hr(props?: Props, build?: Build): El { return this.mk("hr", props, build); }

  /** 兜底：任意 tag。 */
  tag(name: string, props?: Props, build?: Build): El {
    return this.mk(name, props, build);
  }

  /** 把组件挂到本节点。组件 = 纯函数 `(node, payload) => void`。 */
  mount<P>(comp: (self: El, payload: P) => void, payload: P): El {
    comp(this.host, payload);
    return this;
  }

  /** 注册一个随本节点作用域释放的回调（手动清理用）。 */
  onDispose(fn: Disposer): void {
    addDisposer(fn);
  }

  // ── 节点方法（`.unsafe` 里用；也通用） ──────────────────

  /**
   * 反应式逃生块：像尾部函数一样自动追踪信号，但**不清空/不对账子节点**——
   * 你在 `fn` 里用 `insert/remove/removeSelf` 自己驱动。
   * 可与 `text` 共存（不占 children 通道）；与尾部函数互斥。
   */
  unsafe(fn: (n: El) => void): El {
    const own = (this.ownScope ??= []);
    let runScope: Disposer[] = [];
    const runner = effect(() => {
      disposeAll(runScope);
      runScope = pushScope();
      try {
        fn(this);
      } finally {
        popScope();
      }
    });
    own.push(() => {
      stop(runner);
      disposeAll(runScope);
    });
    return this;
  }

  /** 移除自身（+ 释放自身子树作用域），并从父节点的 key 表摘掉。 */
  removeSelf(): void {
    const p = this.parent();
    if (p?.keyedChildren) {
      for (const [k, e] of p.keyedChildren) if (e.el === this.el) p.keyedChildren.delete(k);
    }
    if (this.ownScope) disposeAll(this.ownScope);
    this.el.remove();
  }

  /** 按 key 移除本节点里的一个子节点（释放其作用域）。 */
  remove(key: unknown): void {
    const t = this.keyedChildren;
    const e = t?.get(key);
    if (!t || !e) return;
    t.delete(key);
    disposeAll(e.scope);
    e.el.remove();
  }

  /**
   * 往本节点插一个子节点。`build` 收本节点为 slot、建出**一个**子元素并返回它。
   * 带 `key` 时进本节点的 key 表（同 key 同 rev → 复用，不重建）。
   */
  insert(build: (slot: El) => El, opts: { key?: unknown; rev?: unknown; at?: number } = {}): El {
    const key = opts.key;
    const table = (this.keyedChildren ??= new Map<unknown, KeyedChild<El>>());
    const rev = opts.rev ?? key ?? {};
    if (key !== undefined) {
      const old = table.get(key);
      if (old && old.rev === rev) return old.handle;
    }
    const child = build(this);
    const entry: KeyedChild<El> = { el: child.el, handle: child, rev, scope: child.ownScope ?? [] };
    const slotKey = key !== undefined ? key : child.el;
    const old = table.get(slotKey);
    if (old) {
      disposeAll(old.scope);
      old.el.remove();
    }
    table.set(slotKey, entry);
    if (opts.at !== undefined) {
      const els = [...table.values()].map((e) => e.el);
      const ref = els[opts.at + 1] ?? null;
      this.el.insertBefore(child.el, ref);
    }
    return child;
  }

  /** 按 key 换序（把该项挪到第 to 位）。 */
  move(key: unknown, to: number): void {
    const t = this.keyedChildren;
    const e = t?.get(key);
    if (!t || !e) return;
    const els = [...t.values()].map((x) => x.el);
    const cur = els.indexOf(e.el);
    if (cur < 0) return;
    els.splice(cur, 1);
    els.splice(Math.max(0, Math.min(to, els.length)), 0, e.el);
    for (const el of els) this.el.appendChild(el);
  }

  get(key: unknown): El | undefined {
    const e = this.keyedChildren?.get(key);
    return e ? e.handle : undefined;
  }

  has(key: unknown): boolean {
    return this.keyedChildren?.has(key) ?? false;
  }

  /** 最近的祖先节点（可选匹配选择器）。 */
  parent(sel?: string): El | undefined {
    let p = this.el.parentElement;
    while (p) {
      const n = nodeOf(p);
      if (n && (!sel || p.matches(sel))) return n as unknown as El;
      if (p === document.body) break;
      p = p.parentElement;
    }
    return undefined;
  }
}

// ── DslApp：根 + signal + ambient ───────────────────────────

export interface DslAppOptions {
  mount: string | HTMLElement;
  mode?: "dev" | "prod";
}

export class DslApp extends El {
  readonly root: HTMLElement;
  readonly mode: "dev" | "prod";

  constructor(opts: DslAppOptions) {
    const root =
      typeof opts.mount === "string"
        ? document.querySelector<HTMLElement>(opts.mount)
        : opts.mount;
    if (!root) throw new Error(`DslApp: 挂载点未找到: ${String(opts.mount)}`);
    super(root);
    this.app = this;
    this.root = root;
    this.mode = opts.mode ?? "dev";
    root.replaceChildren();
  }

  /** app.xxx() 挂到「当前组装节点」；顶层则挂到根。 */
  protected override get host(): El {
    return ambientNode() ?? this;
  }

  signal<T>(initial: T): Signal<T> {
    return new Signal(initial);
  }

  /** 各节点的 rerun 计数快照（dev 排查异常 rerun）。 */
  dumpReruns(): Array<{ el: HTMLElement; reruns: number }> {
    return dumpReruns();
  }

  /** rerun 计数分布（dev 排查异常 rerun）。 */
  rerunStats(): { nodes: number; rerun: number; max: number; histogram: Record<string, number> } {
    return computeRerunStats();
  }
}

// ── 实例化 ──────────────────────────────────────────────────

function createEl(parent: El, tag: string, props?: Props, build?: Build): El {
  if (build && props && "text" in props) {
    throw new Error(`dom-dsl: <${tag}> 不能同时给 text 与尾部函数（文本是叶子）`);
  }

  const ctx = reconcileStack[reconcileStack.length - 1];
  const keyed = ctx !== undefined && ctx.parent === parent;

  let key: unknown;
  let rev: unknown;
  if (keyed) {
    const hasKey = props !== undefined && props.key !== undefined;
    key = hasKey ? props!.key : {}; // 无 key → 每轮唯一 token（等价于每轮重建）
    rev = props !== undefined && props.rev !== undefined ? props.rev : key;
    if (hasKey) {
      const old = ctx!.rec.reuse(key, rev);
      if (old) {
        ctx!.rec.keep(key, old); // 复用：不重建、不碰 DOM（顺序由 reorder 收尾）
        return old.handle;
      }
    }
  }

  const node = new El(document.createElement(tag));
  node.app = parent.app;
  trackNode(node);
  // 每个元素自带作用域：removeSelf 才能释放自己；keyed 复用时它存活（状态保留）
  const scope = pushScope();
  node.ownScope = scope;
  try {
    if (props) applyProps(node.el, props);
    if (build) attachBuild(node, build);
  } finally {
    popScope();
  }
  parent.el.appendChild(node.el);
  if (keyed) ctx!.rec.put(key, rev, node, scope);
  return node;
}

/** 尾部函数 = 重跑块：effect 里跑；重跑时对 keyed 直接子节点做差量对账（未 keyed 的等价于全量重建）。 */
function attachBuild(node: El, build: Build): void {
  node.rerunCell = true;
  node.loc = captureLoc();
  let childScope: Disposer[] = [];
  const cleanup = (): void => void disposeAll(childScope);

  const runner = effect(() => {
    cleanup(); // 丢掉上一轮的非 keyed 子树（keyed 子树的存活/释放交给对账）
    const rec = new Reconciler<El>(node.keyedChildren);
    node.keyedChildren = rec.next;
    const s = pushScope();
    nodeStack.push(node);
    reconcileStack.push({ parent: node, rec });
    try {
      build(node);
    } finally {
      reconcileStack.pop();
      nodeStack.pop();
      popScope();
    }
    childScope = s;
    rec.prune(); // 上一轮没被引用的 keyed 子节点 → 释放 + 移除
    rec.reorder(node.el); // 顺序校正（追加场景零移动）
    node.reruns++;
  });

  addDisposer(() => {
    stop(runner);
    cleanup();
    node.keyedChildren?.forEach((e) => disposeAll(e.scope));
  });
}

// ── props → DOM ─────────────────────────────────────────────

export function applyProps(el: HTMLElement, props: Props): void {
  const record = props as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v === undefined) continue;
    if (key === "key" || key === "rev") {
      continue; // 对账令牌，不落 DOM
    } else if (key === "ref") {
      if (typeof v === "function") (v as (el: HTMLElement) => void)(el);
    } else if (key === "text") {
      bindText(el, v);
    } else if (key === "class") {
      bindClass(el, v);
    } else if (key === "style") {
      bindStyle(el, v);
    } else if (key.startsWith("on") && typeof v === "function") {
      bindEvent(el, key, v as EventListener);
    } else if (
      key === "value" ||
      key === "placeholder" ||
      key === "disabled" ||
      key === "checked" ||
      key === "type"
    ) {
      bindProp(el, key, v);
    } else {
      bindAttr(el, key, v);
    }
  }
}

function bindText(el: HTMLElement, v: unknown): void {
  const set = (x: unknown): void => {
    el.textContent = x === null || x === undefined || x === false ? "" : String(x);
  };
  if (isReactive(v)) {
    autoEffect(() => set(unwrap(v)));
  } else {
    set(v);
  }
}

function bindClass(el: HTMLElement, v: unknown): void {
  const set = (x: ClassValue): void => {
    if (x) el.setAttribute("class", String(x));
    else el.removeAttribute("class");
  };
  if (isReactive(v)) {
    autoEffect(() => set(unwrap(v) as ClassValue));
  } else {
    set(v as ClassValue);
  }
}

function bindStyle(el: HTMLElement, v: unknown): void {
  const apply = (x: StyleValue): void => {
    if (typeof x === "string") el.style.cssText = x;
    else for (const [k, s] of Object.entries(x)) (el.style as unknown as Record<string, string>)[k] = String(s);
  };
  if (isReactive(v)) {
    autoEffect(() => apply(unwrap(v) as StyleValue));
  } else {
    apply(v as StyleValue);
  }
}

function bindEvent(el: HTMLElement, key: string, fn: EventListener): void {
  if (key === "onEnter") {
    const handler = (e: Event): void => {
      if ((e as KeyboardEvent).key === "Enter") fn(e);
    };
    el.addEventListener("keydown", handler);
    addDisposer(() => el.removeEventListener("keydown", handler));
    return;
  }
  const type = key.slice(2).toLowerCase();
  el.addEventListener(type, fn);
  addDisposer(() => el.removeEventListener(type, fn));
}

function bindProp(el: HTMLElement, key: string, v: unknown): void {
  const target = el as unknown as Record<string, unknown>;
  const set = (x: unknown): void => {
    if (target[key] !== x) target[key] = x; // 避免无谓赋值（如输入光标跳动）
  };
  if (isReactive(v)) {
    autoEffect(() => set(unwrap(v)));
  } else {
    set(v);
  }
}

function bindAttr(el: HTMLElement, key: string, v: unknown): void {
  const set = (x: unknown): void => {
    if (x === false || x === null || x === undefined) el.removeAttribute(key);
    else el.setAttribute(key, x === true ? "" : String(x));
  };
  if (isReactive(v)) {
    autoEffect(() => set(unwrap(v)));
  } else {
    set(v);
  }
}

// ── 工具 ────────────────────────────────────────────────────

function isReactive(v: unknown): boolean {
  return v instanceof Signal || typeof v === "function";
}

function unwrap<T>(v: Reactive<T>): T {
  if (v instanceof Signal) return v.value as T;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

// ── 组件命名空间（`C.Turn(t)` 环境式调用；与 `parent.mount(Turn, t)` 等价） ──

export type CompBag<R> = {
  [K in keyof R]: R[K] extends (self: El, payload: infer P) => void ? (payload: P) => void : never;
};

/**
 * 把一组组件包成命名空间，调用风格与 tag 工厂一致：
 *   const C = defineComps(app, { Turn, Row });
 *   C.Turn(t);        // 挂到「当前组装节点」
 * 显式指定父节点时用 `parent.mount(Turn, t)`。
 */
export function defineComps<R extends Record<string, (self: El, payload: never) => void>>(
  app: DslApp,
  defs: R,
): CompBag<R> {
  const out = {} as Record<string, (payload: unknown) => void>;
  for (const key of Object.keys(defs) as Array<keyof R & string>) {
    out[key] = (payload: unknown): void => {
      const parent: El = ambientNode() ?? app;
      (defs[key] as unknown as (self: El, payload: unknown) => void)(parent, payload);
    };
  }
  return out as CompBag<R>;
}
