/**
 * test/fake-dom.ts — DOM provider 测试用的最小假 DOM（零依赖）。
 *
 * 只实现 dom.ts / dom-dsl.ts 实际用到的 API：
 *   createElement / append / appendChild / insertBefore / replaceChildren / remove
 *   textContent / className / setAttribute / getAttribute / removeAttribute
 *   children / childElementCount / firstChild / nextSibling / parentElement
 *   addEventListener / removeEventListener / dispatch（测试手动触发）
 *
 * 不做样式计算（style 只是个存值对象）；真实浏览器语义另有浏览器实测兜底。
 */

class FakeStyle {
  private map = new Map<string, string>();
  /** dom-dsl 的 bindStyle 走下标赋值（字符串形态走 cssText）。 */
  [k: string]: unknown;

  get cssText(): string {
    return [...this.map].map(([k, v]) => `${k}: ${v}`).join("; ");
  }
  set cssText(v: string) {
    this.map.clear();
    for (const part of v.split(";")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      const name = part.slice(0, i).trim();
      if (name) this.map.set(name, part.slice(i + 1).trim());
    }
  }
  setProperty(name: string, value: string): void {
    this.map.set(name, value);
  }
  removeProperty(name: string): void {
    this.map.delete(name);
  }
  getPropertyValue(name: string): string {
    return this.map.get(name) ?? "";
  }
}

export class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  style = new FakeStyle();
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  private ownText = "";

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  // ── 文本 ──────────────────────────────────────────────
  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children.length = 0;
    this.ownText = v;
  }

  // ── 属性 ──────────────────────────────────────────────
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }

  // ── 树 ────────────────────────────────────────────────
  appendChild(child: FakeElement): FakeElement {
    child.parentNode?.removeChildNode(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      if (typeof n === "string") this.ownText += n;
      else this.appendChild(n);
    }
  }
  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    if (!ref) return this.appendChild(child);
    const i = this.children.indexOf(ref);
    child.parentNode?.removeChildNode(child);
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    child.parentNode = this;
    return child;
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const c of [...this.children]) c.parentNode = null;
    this.children.length = 0;
    this.ownText = "";
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    this.parentNode?.removeChildNode(this);
  }
  private removeChildNode(child: FakeElement): void {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeElement | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.children[p.children.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  get childElementCount(): number {
    return this.children.length;
  }

  // ── 查询 ──────────────────────────────────────────────
  matches(sel: string): boolean {
    if (sel.startsWith(".")) return this.className.split(/\s+/).includes(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeElement): void => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  // ── 事件 ──────────────────────────────────────────────
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** 测试手动派发（只派发本节点）。 */
  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type });
  }
}

/** 安装全局 document（返回卸载函数）。 */
export function installFakeDom(): () => void {
  const g = globalThis as unknown as { document?: unknown };
  const prev = g.document;
  const doc = {
    createElement: (tag: string) => new FakeElement(tag),
    querySelector: () => null,
    body: new FakeElement("body"),
  };
  g.document = doc;
  return () => {
    g.document = prev;
  };
}
