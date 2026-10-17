/**
 * ⚠️ 实验代码（未采纳，留作参考）。
 * 这是「用 JSX 做声明式层」的一次尝试。当前方向已改为**纯 TS builder（不用 JSX）**，
 * 本文件与 demo/chat_ui_demo.tsx 仅作为对比样本保留，不接入正式 API。
 * 相关改动：web/tsconfig.json 的 jsx 配置、web/vite.config.ts 的 esbuild.jsxFactory。
 *
 * dom-jsx — DOM provider 的**声明式层**（仿 Solid/React 的 JSX，无 VDOM）。
 *
 * 为什么需要它：providers/dom.ts 只提供命令式工厂（`app.column()` / `node.row()`），
 * 建出来的节点没有「属性/结构」的声明入口，于是样式只能落到
 * `node.el.classList.add(...)` / `el.className = ...` —— `el` 泄漏到业务代码里。
 *
 * 本层把 JSX 一次性**实例化**成真实 DOM（不做 diff，和 Solid 的编译产物同构），
 * 并提供与框架其余部分同源的响应式：
 *   - 结构：`<div class="x"><Row/></div>`（属性 → class/style/属性/事件）
 *   - 响应式文本/属性：`{someSignal}` / `class={someSignal}` —— 细粒度 effect，
 *     只改那一个文本节点/属性（对齐 Solid 的 signal 绑定）
 *   - 重绘块：`cell={() => <.../>}` —— 复用既有 cell 语义（清空 stage → 重跑），
 *     用于列表这类「整体重算」的场景
 *   - 逃生口：`ref={(el) => ...}` —— 仅在必须直接操作 DOM 时用（如滚动定位）
 *
 * 用法：在 .tsx 里 `import { h, Fragment } from ".../dom-jsx.js"`，
 * 由 esbuild/tsc 的 `jsxFactory: "h"` / `jsxFragmentFactory: "Fragment"` 编译。
 */

import { effect } from "@vue/reactivity";
import { Signal } from "../signal.js";
import type { ScopeNode } from "../scope.js";
import { DomContainer, DomText, type CellFn } from "./dom.js";

// ── 类型 ────────────────────────────────────────────────────

/** 可以是普通值、Signal，或 getter（三者写法一致）。 */
export type Reactive<T> = T | Signal<T> | (() => T);
export type ClassValue = string | null | undefined | false;
export type StyleValue = string | Partial<CSSStyleDeclaration>;

/** 一个子节点：元素、文本、响应式表达式、数组（map 结果）、或空。 */
export type VChild =
  | VNode
  | string
  | number
  | Signal<unknown>
  | (() => unknown)
  | VChild[]
  | null
  | undefined
  | false
  | true;

/**
 * 元素的 props。**故意不加字符串索引签名** —— 加了之后 TS 会要求所有
 * 组件 props 也带索引签名，function component 就都不可赋值了。
 * 未列出的属性照旧在运行时走 `bindAttr`（见 applyProps）。
 */
export interface IntrinsicProps {
  class?: Reactive<ClassValue>;
  style?: Reactive<StyleValue>;
  /** 逃生口：拿到真实元素（仅在必须直接操作 DOM 时用，如滚动）。 */
  ref?: (el: HTMLElement) => void;
  /** 重绘块：返回值会被挂进 cell 的 stage（对齐 `node.cell()`）。 */
  cell?: CellBody;
  value?: Reactive<string | number>;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** 便捷：回车触发（内部监听 keydown + key==="Enter"）。 */
  onEnter?: (e: KeyboardEvent) => void;
  children?: VChild;
}

/**
 * 组件：arrt 收 `never` 是为了让**任意** `(props: {...}) => VNode` 都能赋值进来
 * （函数参数逆变：never 可赋给任何形参），同时避免用 `any`。
 */
export type Component = (props: never) => VNode;
export type CellBody = (stage: DomContainer) => VChild;

export interface VNode {
  readonly __vnode: true;
  readonly tag: string | Component;
  readonly props: IntrinsicProps;
  readonly children: VChild[];
}

// ── JSX 运行时（classic runtime：jsxFactory = h） ───────────

export function h(
  tag: string | Component,
  props: Record<string, unknown> | null,
  ...children: VChild[]
): VNode {
  return { __vnode: true, tag, props: (props ?? {}) as IntrinsicProps, children: flatten(children) };
}

export function Fragment(props: { children?: VChild[] }): VNode {
  return h("#fragment", null, ...(props.children ?? []));
}

function flatten(children: VChild[]): VChild[] {
  const out: VChild[] = [];
  for (const c of children) {
    if (Array.isArray(c)) out.push(...flatten(c));
    else out.push(c);
  }
  return out;
}

// ── 挂载：一次性实例化为真实 DOM（无 diff） ─────────────────

/** 通用元素：任意 HTML tag。样式/属性全走 props，不再需要 `el.xxx`。 */
export class DomElement extends DomContainer {
  constructor(tag: string, parent?: ScopeNode) {
    super(document.createElement(tag), undefined, parent);
  }
}

/** 把一个 VChild 挂进容器。数组递归展开，空值忽略。 */
export function mount(parent: DomContainer, node: VChild): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const c of node) mount(parent, c);
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    // 忽略 JSX 缩进留下的纯空白文本节点（有意空格请用 {" "}）
    if (typeof node === "string" && node.trim() === "") return;
    new DomText(String(node), undefined, parent);
    return;
  }
  if (node instanceof Signal) {
    bindText(parent, () => node.value);
    return;
  }
  if (isVNode(node)) {
    mountVNode(parent, node);
    return;
  }
  if (typeof node === "function") {
    bindText(parent, node);
  }
}

function mountVNode(parent: DomContainer, v: VNode): void {
  if (v.tag === "#fragment") {
    for (const c of v.children) mount(parent, c);
    return;
  }
  if (typeof v.tag === "function") {
    const comp = v.tag as unknown as (props: IntrinsicProps) => VNode;
    mount(parent, comp({ ...v.props, children: v.children }));
    return;
  }
  const el = new DomElement(v.tag, parent);
  // cell 元素由 cell 自己产出子节点；静态子节点会与 stage 冲突，故二选一
  if (typeof v.props.cell !== "function") {
    for (const c of v.children) mount(el, c);
  }
  applyProps(el, v.props);
}

function isVNode(v: unknown): v is VNode {
  return typeof v === "object" && v !== null && (v as { __vnode?: unknown }).__vnode === true;
}

// ── props → DOM ─────────────────────────────────────────────

function applyProps(el: DomElement, props: IntrinsicProps): void {
  const record = props as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v === undefined || v === null) continue;
    if (key === "children") continue;
    if (key === "cell") {
      el.cell(wrapCell(v as CellBody));
      continue;
    }
    if (key === "ref") {
      (v as (e: HTMLElement) => void)(el.el);
      continue;
    }
    if (key === "class") {
      bindClass(el.el, v as Reactive<ClassValue>);
      continue;
    }
    if (key === "style") {
      bindStyle(el.el, v as Reactive<StyleValue>);
      continue;
    }
    if (key.startsWith("on") && typeof v === "function") {
      bindEvent(el.el, key, v as EventListener);
      continue;
    }
    if (key === "value" || key === "placeholder" || key === "disabled" || key === "checked") {
      bindProp(el.el, key, v);
      continue;
    }
    bindAttr(el.el, key, v);
  }
}

function bindText(parent: DomContainer, get: () => unknown): void {
  const t = new DomText("", undefined, parent);
  effect(() => {
    const v = get();
    t.el.textContent = v === null || v === undefined || v === false ? "" : String(v);
  });
}

function bindClass(el: HTMLElement, v: Reactive<ClassValue>): void {
  const set = (val: ClassValue): void => {
    el.setAttribute("class", val ? String(val) : "");
  };
  if (isReactive(v)) effect(() => set(unwrap(v) as ClassValue));
  else set(v as ClassValue);
}

function bindStyle(el: HTMLElement, v: Reactive<StyleValue>): void {
  const apply = (val: StyleValue): void => {
    if (typeof val === "string") el.style.cssText = val;
    else
      for (const [k, s] of Object.entries(val))
        (el.style as unknown as Record<string, string>)[k] = String(s);
  };
  if (isReactive(v)) effect(() => apply(unwrap(v) as StyleValue));
  else apply(v as StyleValue);
}

function bindEvent(el: HTMLElement, key: string, fn: EventListener): void {
  if (key === "onEnter") {
    el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") fn(e);
    });
    return;
  }
  el.addEventListener(key.slice(2).toLowerCase(), fn);
}

function bindProp(el: HTMLElement, key: string, v: unknown): void {
  const target = el as unknown as Record<string, unknown>;
  if (isReactive(v)) effect(() => { target[key] = unwrap(v as Reactive<unknown>); });
  else target[key] = v;
}

function bindAttr(el: HTMLElement, key: string, v: unknown): void {
  const set = (val: unknown): void => {
    if (val === false || val === null || val === undefined) el.removeAttribute(key);
    else el.setAttribute(key, val === true ? "" : String(val));
  };
  if (isReactive(v)) effect(() => set(unwrap(v as Reactive<unknown>)));
  else set(v);
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

function wrapCell(fn: CellBody): CellFn {
  return (stage) => {
    const r = fn(stage);
    if (r !== undefined) mount(stage, r);
  };
}

// ── JSX 类型（classic runtime 需要 JSX 命名空间） ───────────

declare global {
  namespace JSX {
    type Element = VNode;
    interface ElementChildrenAttribute {
      children: unknown;
    }
    interface IntrinsicElements {
      [name: string]: IntrinsicProps;
    }
  }
}
