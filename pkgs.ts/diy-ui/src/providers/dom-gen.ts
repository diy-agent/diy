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
import {
  applyProps,
  pushScope,
  popScope,
  addDisposer,
  disposeAll,
  trackNode,
  captureLoc,
  computeRerunStats,
  type Props,
} from "./dom-dsl.js";

type Disposer = () => void;

// ── Spec：元素描述（纯数据，不碰 DOM） ───────────────────────

export interface Spec {
  readonly tag: string;
  readonly props: Props;
  readonly children?: ChildGen;
  /** 定义处（file:line，dev 诊断用；仅在 devtools 开启采集时才有值）。 */
  readonly loc?: string;
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
  constructor(el: HTMLElement, app: GenApp) {
    this.el = el;
    this.app = app;
  }
}

// ── html：tag 工厂（只产 Spec） ──────────────────────────────

function spec(tag: string, props?: Props, children?: ChildGen): Spec {
  // 只给「重跑块」（有子生成器）采 loc —— 静态叶子不需要，省成本
  return { tag, props: props ?? {}, children, loc: children ? captureLoc() : undefined };
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
  applyProps(node.el, spec.props);
  if (spec.children) attachGen(node, spec.children);
  parent.appendChild(node.el);
  return node;
}

/** 元素的 children 生成器 = 重跑块：effect 里 drain；重跑时清空并释放。 */
function attachGen(node: GenNode, gen: ChildGen): void {
  node.rerunCell = true;
  let childScope: Disposer[] = [];
  const cleanup = (): void => void disposeAll(childScope);

  const runner = effect(() => {
    cleanup();
    node.el.replaceChildren();
    const s = pushScope();
    try {
      for (const child of gen(node)) {
        if (child) instantiate(child, node.el, node.app);
      }
    } finally {
      popScope();
    }
    childScope = s;
    node.reruns++;
  });

  addDisposer(() => {
    stop(runner);
    cleanup();
  });
}
