/// <reference lib="dom" />
/**
 * dom-gen — DOM provider 的 **generator/pull 声明式层**（B 风格）。
 *
 * 与 A（dom-dsl）同功能、不同构造模型，用于对照可读性：
 *
 *   A（eager）：`d.div(props, (turn) => { turn.span(...) })`
 *      —— 调用即建真实元素、尾部函数立即组装 children。
 *   B（pull）：`html.div(props, function* (d) { yield html.span(...) })`
 *      —— `html.xxx()` 只产出 **Spec（纯数据）**；最外层 `app.render(spec)` 才
 *         `createElement`，按树逐级**拉取**生成器组装 children，最后**一次性提交**。
 *
 * 共同点（复用 dom-dsl 的运行时）：props 绑定（Signal/getter → 细粒度 effect）、
 * 文本走 `text` prop、`ref` 逃生口、rerun 计数。
 *
 * 重跑块：某个元素的 children 生成器在 `effect` 里被 drain，读到信号就订阅；
 * 信号变 → 清空该元素子节点 → 重新 drain。首屏构建不需要追踪，因此**可分片/离屏**；
 * 依赖一律**在生成器里同步读**（`yield` 之间读都算，因为 driver 同步 drain）。
 */

import { effect, stop } from "@vue/reactivity";
import { Signal } from "../signal.js";
// 浏览器侧最常用的一对（声明式结构 + 响应式）从同一入口拿：html + Signal
export { Signal };
import {
  applyProps,
  untrackNode,
  pushScope,
  popScope,
  addDisposer,
  disposeAll,
  trackNode,
  nodeOf,
  captureLoc,
  computeRerunStats,
  Reconciler,
  type KeyedChild,
  type Props,
} from "./dom-dsl.js";

type Disposer = () => void;

// ── Spec：元素描述（纯数据，不碰 DOM） ───────────────────────

export interface Spec {
  readonly tag: string;
  readonly props: Props;
  readonly children?: ChildGen;
  /** 行级增量：身份令牌（来自 props.key）。 */
  readonly key?: unknown;
  /** 行级增量：变更令牌（来自 props.rev）；不给则同 key 一律复用。 */
  readonly rev?: unknown;
  /** 定义处（file:line，dev 诊断用；仅在 devtools 开启采集时才有值）。 */
  readonly loc?: string;
  /** `.unsafe(fn)` 存的回调：反应式、不清子节点的逃生块。 */
  readonly onUnsafe?: (n: GenNode) => void;
  /** 逃生口：`html.div({...}).unsafe((n) => { ... })`。 */
  unsafe(fn: (n: GenNode) => void): Spec;
}

/** 子节点生成器：pull 语义；收到父节点（可选，用作逃生口/测量）。 */
export type ChildGen = (
  self: GenNode,
) => Generator<Spec | null | undefined | false, void, unknown>;

/** B 风格节点句柄（由 driver 实例化时创建）。 */
export class GenNode {
  readonly el: HTMLElement;
  readonly app: GenApp;
  reruns = 0;
  /** 是否重跑块（有子生成器）；静态叶子为 false。 */
  rerunCell?: boolean;
  /** 定义处（file:line，dev 诊断用）。 */
  loc?: string;
  /** 本元素上一轮的 keyed 子节点（行级增量对账用）。 */
  keyedChildren?: Map<unknown, KeyedChild<GenNode>>;
  /** 自身作用域（props 副作用 + `.unsafe` 块 + 子节点注册）；`removeSelf()` 时释放。 */
  ownScope?: Disposer[];
  constructor(el: HTMLElement, app: GenApp) {
    this.el = el;
    this.app = app;
  }

  // ── 节点方法（`.unsafe` 里用；也通用） ──────────────────

  /** 移除自身（+ 释放自身子树作用域），并从父节点的 key 表摘掉。 */
  removeSelf(): void {
    const p = this.parent();
    if (p?.keyedChildren) {
      for (const [k, e] of p.keyedChildren) if (e.el === this.el) p.keyedChildren.delete(k);
    }
    if (this.ownScope) disposeAll(this.ownScope);
    this.el.remove();
    untrackNode(this);
  }

  /** 按 key 移除本节点里的一个子节点（释放其作用域）。 */
  remove(key: unknown): void {
    const t = this.keyedChildren;
    const e = t?.get(key);
    if (!t || !e) return;
    t.delete(key);
    disposeAll(e.scope);
    e.el.remove();
    untrackNode(e.handle);
  }

  /** 往本节点插一个子 Spec。带 `key` 时进本节点 key 表（同 key 同 rev → 复用）。 */
  insert(spec: Spec, opts: { key?: unknown; rev?: unknown; at?: number } = {}): GenNode {
    const key = opts.key ?? spec.key;
    const table = (this.keyedChildren ??= new Map<unknown, KeyedChild<GenNode>>());
    const rev = opts.rev ?? spec.rev ?? key ?? {};
    if (key !== undefined) {
      const old = table.get(key);
      if (old && old.rev === rev) return old.handle;
    }
    const child = instantiate(spec, this.el, this.app);
    const slotKey = key !== undefined ? key : child.el;
    const old = table.get(slotKey);
    if (old) {
      disposeAll(old.scope);
      old.el.remove();
    }
    table.set(slotKey, { el: child.el, handle: child, rev, scope: child.ownScope ?? [] });
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

  get(key: unknown): GenNode | undefined {
    const e = this.keyedChildren?.get(key);
    return e ? e.handle : undefined;
  }

  has(key: unknown): boolean {
    return this.keyedChildren?.has(key) ?? false;
  }

  /** 最近的祖先节点（可选匹配选择器）。 */
  parent(sel?: string): GenNode | undefined {
    let p = this.el.parentElement;
    while (p) {
      const n = nodeOf(p);
      if (n && (!sel || p.matches(sel))) return n as unknown as GenNode;
      if (p === document.body) break;
      p = p.parentElement;
    }
    return undefined;
  }
}

// ── html：tag 工厂（只产 Spec） ──────────────────────────────

function spec(tag: string, props?: Props, children?: ChildGen): Spec {
  // 只给「重跑块」（有子生成器）采 loc —— 静态叶子不需要，省成本
  const base = {
    tag,
    props: props ?? {},
    children,
    key: props?.key,
    rev: props?.rev,
    loc: children ? captureLoc() : undefined,
  };
  const mk = (onUnsafe?: (n: GenNode) => void): Spec => ({
    ...base,
    onUnsafe,
    unsafe(fn: (n: GenNode) => void): Spec {
      return mk(fn);
    },
  });
  return mk();
}

type Tag = (props?: Props, children?: ChildGen) => Spec;

export const html: {
  tag: (name: string, props?: Props, children?: ChildGen) => Spec;
  div: Tag;
  span: Tag;
  p: Tag;
  a: Tag;
  button: Tag;
  input: Tag;
  textarea: Tag;
  label: Tag;
  img: Tag;
  ul: Tag;
  ol: Tag;
  li: Tag;
  h1: Tag;
  h2: Tag;
  h3: Tag;
  h4: Tag;
  section: Tag;
  header: Tag;
  footer: Tag;
  main: Tag;
  pre: Tag;
  code: Tag;
  strong: Tag;
  em: Tag;
  small: Tag;
  br: Tag;
  hr: Tag;
} = (() => {
  const tags = [
    "div", "span", "p", "a", "button", "input", "textarea", "label", "img",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "section", "header", "footer",
    "main", "pre", "code", "strong", "em", "small", "br", "hr",
  ];
  const out: Record<string, unknown> = {
    tag: (name: string, props?: Props, children?: ChildGen) => spec(name, props, children),
  };
  for (const t of tags) out[t] = (props?: Props, children?: ChildGen) => spec(t, props, children);
  return out as never;
})();

// ── GenApp：根 + signal + 提交 ──────────────────────────────

export interface GenAppOptions {
  mount: string | HTMLElement;
}

export class GenApp {
  readonly root: HTMLElement;

  constructor(opts: GenAppOptions) {
    const root =
      typeof opts.mount === "string"
        ? document.querySelector<HTMLElement>(opts.mount)
        : opts.mount;
    if (!root) throw new Error(`GenApp: 挂载点未找到: ${String(opts.mount)}`);
    this.root = root;
    root.replaceChildren();
  }

  signal<T>(initial: T): Signal<T> {
    return new Signal(initial);
  }

  /** 实例化整片 spec 森林：全部离屏构建 → 最后一次性 append 提交。 */
  render(...roots: Spec[]): void {
    const frag = document.createDocumentFragment();
    for (const r of roots) instantiate(r, frag, this);
    this.root.append(frag);
  }

  /** rerun 计数分布（dev 排查异常 rerun）。 */
  rerunStats(): { nodes: number; rerun: number; max: number; histogram: Record<string, number> } {
    return computeRerunStats();
  }
}

// ── driver：Spec → 真实 DOM ─────────────────────────────────

function instantiate(spec: Spec, parent: Node, app: GenApp): GenNode {
  const node = new GenNode(document.createElement(spec.tag), app);
  node.loc = spec.loc;
  trackNode(node);
  // 每个元素自带作用域：removeSelf 才能释放自己；keyed 复用时它存活（状态保留）
  const scope = pushScope();
  node.ownScope = scope;
  try {
    applyProps(node.el, spec.props);
    if (spec.children) attachGen(node, spec.children);
    if (spec.onUnsafe) attachUnsafe(node, spec.onUnsafe);
  } finally {
    popScope();
  }
  parent.appendChild(node.el);
  return node;
}

/** `.unsafe` 块：反应式、不清子节点的逃生块。 */
function attachUnsafe(node: GenNode, fn: (n: GenNode) => void): void {
  const own = (node.ownScope ??= []);
  let runScope: Disposer[] = [];
  const runner = effect(() => {
    disposeAll(runScope);
    runScope = pushScope();
    try {
      fn(node);
    } finally {
      popScope();
    }
  });
  own.push(() => {
    stop(runner);
    disposeAll(runScope);
  });
}

/** 元素的 children 生成器 = 重跑块：effect 里 drain；对 keyed 子节点做差量对账。 */
function attachGen(node: GenNode, gen: ChildGen): void {
  node.rerunCell = true;
  let childScope: Disposer[] = [];
  const cleanup = (): void => void disposeAll(childScope);

  const runner = effect(() => {
    cleanup();
    const rec = new Reconciler<GenNode>(node.keyedChildren);
    node.keyedChildren = rec.next;
    const s = pushScope();
    try {
      for (const child of gen(node)) {
        if (!child) continue;
        reconcileChild(child, node, rec);
      }
    } finally {
      popScope();
    }
    childScope = s;
    rec.prune();
    rec.reorder(node.el);
    node.reruns++;
  });

  addDisposer(() => {
    stop(runner);
    cleanup();
    node.keyedChildren?.forEach((e) => disposeAll(e.scope));
  });
}

/** 一个 yield 出来的子节点：keyed 的按 key 复用，否则新建（无 key = 每轮唯一 token）。 */
function reconcileChild(spec: Spec, parent: GenNode, rec: Reconciler<GenNode>): void {  const hasKey = spec.key !== undefined;
  const key = hasKey ? spec.key : {};
  const rev = spec.rev !== undefined ? spec.rev : key;
  if (hasKey) {
    const old = rec.reuse(key, rev);
    if (old) {
      rec.keep(key, old);
      return;
    }
  }
  const gn = instantiate(spec, parent.el, parent.app);
  rec.put(key, rev, gn, gn.ownScope ?? []);
}

// ── mountStream：把「异步流」挂到一个节点上（真·增量投递） ─────

export interface MountStreamOptions<T> {
  /** 每条的身份 key（传给 `node.insert`；同 key 会复用而不是重复插入）。 */
  key?: (item: T, index: number) => unknown;
  /** 变更令牌；同 key + 不同 rev 会替换该条（就地更新）。 */
  rev?: (item: T, index: number) => unknown;
  /** 外部取消信号（组件卸载 / 用户切走时 abort）。 */
  signal?: AbortSignal;
  onError?: (e: unknown) => void;
}

/**
 * 消费一个异步流，**每来一条就 insert 一条**：
 *
 *   mountStream(node, sseSource, (m) => bubble(m), { key: (m) => m.id });
 *
 * 与 children 生成器的区别（也是它存在的理由）：
 *   - **不重跑**：整棵重跑块一次都不 drain，0 次 key 查表、0 次 reorder；
 *   - **实时**：每条到达立即上屏，不等一批凑齐；
 *   - **代价**：只能追加/按 key 替换，不能重排整表、不能整表重渲染。
 *
 * 语义对齐 py 版 `_execute_cell_generator`（每 yield 一次就 `_add_child`），
 * 但 JS 没有跨 await 的 ambient 上下文，所以挂载点是**显式传入的 node**。
 *
 * 返回停止函数；节点被销毁时也会自动停止（挂在其 `ownScope` 上）。
 */
export function mountStream<T>(
  node: GenNode,
  source: AsyncIterable<T>,
  render: (item: T, index: number) => Spec,
  opts: MountStreamOptions<T> = {},
): () => void {
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  // 节点销毁（removeSelf / keyed prune）时自动停，避免消费循环挂在一个死节点上
  node.ownScope?.push(stop);
  opts.signal?.addEventListener("abort", stop, { once: true });

  void (async () => {
    const it = source[Symbol.asyncIterator]();
    // 取消时把迭代器也 return 掉，否则它永远停在 await 上（泄漏）
    const onAbort = (): void => void it.return?.(undefined);
    ac.signal.addEventListener("abort", onAbort, { once: true });
    let i = 0;
    try {
      for (;;) {
        const r = await it.next();
        if (ac.signal.aborted) break;
        if (r.done) break;
        const item = r.value;
        node.insert(render(item, i), { key: opts.key?.(item, i), rev: opts.rev?.(item, i) });
        i++;
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        (opts.onError ?? ((err: unknown) => console.error("[mountStream]", err)))(e);
      }
    } finally {
      ac.signal.removeEventListener("abort", onAbort);
      opts.signal?.removeEventListener("abort", stop);
    }
  })();

  return stop;
}
