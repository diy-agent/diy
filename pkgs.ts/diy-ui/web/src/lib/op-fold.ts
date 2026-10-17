/**
 * Op 流 → 块树的 fold（纯函数）—— **vendored** from
 * `pkgs.ts/diy-app/src/main/services/local-blocks.ts`。
 *
 * 只搬「fold + 树导出」这一段（Op/Block 类型、SCHEMA、BlockStore、replay、compactOps、
 * toForest）。投递/压缩/消息投影那些与 UI 无关的下游逻辑没搬。
 * 保持逐行一致，便于将来抽成共享层时不产生行为分叉。
 *
 * 协议要点：start/stop 配对定义嵌套（parent 缺省 = 当前最深打开节点）；
 * delta 按声明类型累加（Text 追加 / List push）；patch 按路径覆盖；
 * 字段类型在 SCHEMA 声明，wire 不携带类型。
 */

export type JSONVal = string | number | boolean | null | JSONVal[] | { [k: string]: JSONVal };

export type BlockKind = "turn" | "step" | "text" | "think" | "tool" | "plan" | "error";

export type Op =
  | { op: "start"; id: string; kind: BlockKind; parent?: string | null; meta?: Record<string, JSONVal> }
  | { op: "delta"; id: string; fields: Record<string, JSONVal> }
  | { op: "patch"; id: string; fields: Record<string, JSONVal> }
  | { op: "stop"; id: string };

/** 运行时块：kind 声明字段的扁平容器 + 结构位 */
export interface Block {
  id: string;
  kind: BlockKind;
  parent?: string;
  children: string[];
  stopped: boolean;
  touched: number;
  [field: string]: unknown;
}

type FieldKind = "Text" | "List" | "Flag";

const SCHEMA: Record<BlockKind, Record<string, FieldKind>> = {
  turn: { usage: "Flag", status: "Flag", notice: "Flag", reasoningEffort: "Flag", durationMs: "Flag", endReason: "Flag" },
  step: { model: "Flag", usage: "Flag", status: "Flag" },
  text: { role: "Flag", content: "Text", steer: "Flag", steerId: "Flag" },
  think: { content: "Text" },
  tool: { tool: "Flag", title: "Flag", status: "Flag", input: "Text", args: "Flag", output: "Text" },
  plan: { items: "List" },
  error: { source: "Flag", message: "Text" },
};

export interface FoldIssue {
  op: Op;
  reason: string;
}

export class BlockStore {
  readonly blocks = new Map<string, Block>();
  /** 当前最深打开节点（start 隐式 parent 用；允许非 LIFO 关闭） */
  private openStack: string[] = [];
  readonly issues: FoldIssue[] = [];
  private seq = 0;

  private touch(id: string): void {
    const b = this.blocks.get(id);
    if (b) b.touched = ++this.seq;
  }

  apply(op: Op): void {
    switch (op.op) {
      case "start": {
        if (this.blocks.has(op.id)) {
          this.issues.push({ op, reason: `重复 start: ${op.id}` });
          return;
        }
        const parent =
          op.kind === "turn" || op.parent === null
            ? undefined
            : (op.parent ?? this.openStack[this.openStack.length - 1]);
        if (parent !== undefined && !this.blocks.has(parent)) {
          this.issues.push({ op, reason: `parent 不存在: ${parent}` });
        }
        const b: Block = { id: op.id, kind: op.kind, children: [], stopped: false, touched: 0 };
        if (parent !== undefined && this.blocks.has(parent)) {
          b.parent = parent;
          this.blocks.get(parent)!.children.push(op.id);
        }
        for (const [k, v] of Object.entries(op.meta ?? {})) {
          if (k === "children" || k === "id" || k === "kind") continue;
          (b as Record<string, unknown>)[k] = v;
        }
        this.blocks.set(op.id, b);
        this.openStack.push(op.id);
        this.touch(op.id);
        return;
      }
      case "stop": {
        const b = this.blocks.get(op.id);
        if (!b) {
          this.issues.push({ op, reason: `stop 未知块: ${op.id}` });
          return;
        }
        if (!b.stopped) {
          b.stopped = true;
          this.touch(op.id);
        }
        const i = this.openStack.lastIndexOf(op.id);
        if (i >= 0) this.openStack.length = i;
        return;
      }
      case "delta":
      case "patch": {
        const b = this.blocks.get(op.id);
        if (!b) {
          this.issues.push({ op, reason: `${op.op} 未知块: ${op.id}` });
          return;
        }
        let changed = false;
        for (const [path, val] of Object.entries(op.fields ?? {})) {
          const decl = path === "children" ? undefined : SCHEMA[b.kind]?.[path];
          if (op.op === "patch") {
            const cur = path.includes(".") ? getPath(b, path) : (b as Record<string, unknown>)[path];
            if (jsonEqual(cur, val)) continue;
            if (path.includes(".")) setPath(b, path, val);
            else (b as Record<string, unknown>)[path] = val;
            changed = true;
            continue;
          }
          if (decl === undefined) {
            this.issues.push({ op, reason: `未知字段 ${b.kind}.${path}，delta 降级为 patch` });
            setPath(b, path, val);
            changed = true;
            continue;
          }
          if (decl === "Flag") {
            this.issues.push({ op, reason: `Flag 字段 ${b.kind}.${path} 不接受 delta，忽略` });
            continue;
          }
          const cur = path.includes(".") ? getPath(b, path) : (b as Record<string, unknown>)[path];
          if (decl === "Text") {
            const next = `${typeof cur === "string" ? cur : ""}${typeof val === "string" ? val : JSON.stringify(val)}`;
            if (path.includes(".")) setPath(b, path, next);
            else (b as Record<string, unknown>)[path] = next;
          } else {
            const arr = Array.isArray(cur) ? [...cur] : [];
            if (Array.isArray(val)) arr.push(...(val as JSONVal[]));
            else arr.push(val);
            (b as Record<string, unknown>)[path] = arr;
          }
          changed = true;
        }
        if (changed) this.touch(op.id);
        return;
      }
    }
  }

  roots(): Block[] {
    return [...this.blocks.values()].filter((b) => b.parent === undefined);
  }
}

/** 从持久化 Op 日志重建块树（重放入口） */
export function replay(ops: Op[]): BlockStore {
  const s = new BlockStore();
  for (const op of ops) s.apply(op);
  return s;
}

/** 折叠：块树 → 等价的紧凑 Op 流（每块 start + 终值 patch + stop） */
export function compactOps(store: BlockStore): Op[] {
  const out: Op[] = [];
  const emit = (id: string): void => {
    const b = store.blocks.get(id);
    if (!b) return;
    out.push({ op: "start", id: b.id, kind: b.kind, parent: b.parent ?? null });
    const fields: Record<string, JSONVal> = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === "id" || k === "kind" || k === "parent" || k === "children" || k === "stopped" || k === "touched") continue;
      if (v === undefined) continue;
      fields[k] = v as JSONVal;
    }
    if (Object.keys(fields).length > 0) out.push({ op: "patch", id: b.id, fields });
    for (const c of b.children) emit(c);
    if (b.stopped) out.push({ op: "stop", id: b.id });
  };
  for (const r of store.roots()) emit(r.id);
  return out;
}

// ─── 点分路径读写 ──────────────────────────────────────

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setPath(obj: unknown, path: string, val: unknown): void {
  const segs = path.split(".");
  let cur = obj as Record<string, unknown>;
  for (const s of segs.slice(0, -1)) {
    if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = val;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

// ─── 树导出（带身份缓存：未变的子树返回同一对象）────────

export interface BlockNode {
  tag: string;
  id: string;
  stopped: boolean;
  touched: number;
  attrs: Record<string, unknown>;
  children: BlockNode[];
}

interface TreeCache {
  node: BlockNode;
}
const treeCaches = new WeakMap<BlockStore, Map<string, TreeCache>>();

function cacheOf(store: BlockStore): Map<string, TreeCache> {
  let c = treeCaches.get(store);
  if (!c) {
    c = new Map();
    treeCaches.set(store, c);
  }
  return c;
}

function sameNodes(a: readonly BlockNode[], b: readonly BlockNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildNode(store: BlockStore, rootId: string, cache: Map<string, TreeCache>): BlockNode {
  const b = store.blocks.get(rootId);
  if (!b) {
    return { tag: "error", id: rootId, stopped: true, touched: 0, attrs: {}, children: [] };
  }
  const children = b.children.map((c) => buildNode(store, c, cache));
  const prev = cache.get(rootId)?.node;
  if (prev && prev.touched === b.touched && prev.stopped === b.stopped && sameNodes(prev.children, children)) {
    return prev;
  }
  const { id, kind, children: _kids, stopped, touched, ...attrs } = b;
  delete (attrs as Record<string, unknown>).parent;
  const node: BlockNode = {
    tag: kind,
    id,
    stopped,
    touched,
    attrs: { ...attrs, ...(stopped ? {} : { interrupted: true }) },
    children,
  };
  cache.set(rootId, { node });
  return node;
}

export function toTree(store: BlockStore, rootId: string): BlockNode {
  return buildNode(store, rootId, cacheOf(store));
}

export function toForest(store: BlockStore): BlockNode[] {
  const cache = cacheOf(store);
  return store.roots().map((r) => buildNode(store, r.id, cache));
}
