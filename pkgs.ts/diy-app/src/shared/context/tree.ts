// src/shared/context/tree.ts
// 🎯 值树读写 + places 校验（纯函数，全部返回新对象，不改入参）。
//
// 两个刻意的设计：
//   1. **值树是嵌套 JSON**（不是 path→值的扁平表）。这样「父节点比自身最终 hash」是天然
//      成立的（父的 hash 就是它整棵子树的 hash），不需要给父节点单独累加子节点计数。
//   2. **渲染声明与值分离**（renderers 挂在 path 上，值在 values 里）。模板节点可以没有
//      自己的值，只是「渲染这个 path 时用模板」；于是「值变了但渲染没变」可判（144 用例 14）。

import { hashValue } from "./hash";
import { isAncestor, isValidPath, parsePath } from "./path";
import type {
    ContextContainer,
    ContextPath,
    ContextRendererSpec,
    ContextTreeState,
} from "./types";

/** 初始空树（wireVersion 由 wire.ts 提供，避免此处 import 循环） */
export function emptyState(wireVersion: string): ContextTreeState {
    return { values: {}, renderers: {}, places: [], placement: {}, wireVersion, placementEpoch: 0 };
}

// ─── 值树读写 ───────────────────────────────────────────

/**
 * 按 path 取值树里的值；路径不存在返回 undefined。
 * 数组用**下标段**寻址（`chain.0.content`）—— 与 JSONPath 的 `$..chain[0].content` 对应：
 * 数组元素是独立变量（稳定性各不相同），必须能单独定位、单独投递。
 */
export function getValue(state: ContextTreeState, path: ContextPath): unknown {
    const segs = parsePath(path);
    if (!segs) return undefined;
    let cur: unknown = state.values;
    for (const s of segs) {
        if (cur === null || typeof cur !== "object") return undefined;
        if (Array.isArray(cur)) {
            const i = Number(s);
            if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
            cur = cur[i];
            continue;
        }
        cur = (cur as Record<string, unknown>)[s];
    }
    return cur;
}

/** 按 path 写值（不可变：只拷贝路径上的节点） */
export function setValue(
    state: ContextTreeState,
    path: ContextPath,
    value: unknown,
): ContextTreeState {
    const segs = parsePath(path);
    if (!segs) return state;
    const next = writeNode(state.values, segs, value);
    return { ...state, values: isPlainObject(next) ? next : state.values };
}

function writeNode(
    node: Record<string, unknown> | unknown[],
    segs: readonly string[],
    value: unknown,
): Record<string, unknown> | unknown[] {
    const [head, ...rest] = segs;
    if (Array.isArray(node)) {
        const i = Number(head);
        if (!Number.isInteger(i) || i < 0) return node;
        const copy = node.slice();
        if (rest.length === 0) {
            copy[i] = value;
            return copy;
        }
        const cur = copy[i];
        copy[i] = writeNode(isPlainObject(cur) || Array.isArray(cur) ? cur : {}, rest, value);
        return copy;
    }
    if (rest.length === 0) return { ...node, [head]: value };
    const cur = node[head];
    const base = isPlainObject(cur) || Array.isArray(cur) ? cur : {};
    return { ...node, [head]: writeNode(base, rest, value) };
}

/** 删除 path 处的整棵子树（含值、渲染声明、place 声明） */
export function removePath(state: ContextTreeState, path: ContextPath): ContextTreeState {
    const segs = parsePath(path);
    if (!segs) return state;
    const values = deleteNode(state.values, segs);
    const renderers: Record<ContextPath, ContextRendererSpec> = {};
    for (const [k, v] of Object.entries(state.renderers)) {
        if (k !== path && !isAncestor(path, k)) renderers[k] = v;
    }
    const places = state.places.filter((p) => p !== path && !isAncestor(path, p));
    const placement: Record<ContextPath, ContextContainer> = {};
    for (const [k, v] of Object.entries(state.placement)) {
        if (k !== path && !isAncestor(path, k)) placement[k] = v;
    }
    return { ...state, values, renderers, places, placement };
}

/**
 * 删除子树的**级联清理**：删完若某层变空对象，就把它也摘掉。
 * 不这样做会留下「空壳」——「设了再删」本该回到「不存在」，却变成 `{ tasks: {} }`，
 * 于是 step 比较（144 用例 12）出现假阳性：值明明恢复了，hash 却没恢复。
 */
function deleteNode(node: Record<string, unknown>, segs: readonly string[]): Record<string, unknown> {
    const [head, ...rest] = segs;
    if (!(head in node)) return node;
    if (rest.length === 0) return omit(node, head);
    const cur = node[head];
    if (!isPlainObject(cur)) return node;
    const next = deleteNode(cur, rest);
    if (Object.keys(next).length === 0) return omit(node, head);
    return { ...node, [head]: next };
}

/** 去掉一个 key（保留其余键的插入顺序） */
function omit(o: Record<string, unknown>, key: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
}

/** 设置渲染声明（path 处） */
export function setRenderer(
    state: ContextTreeState,
    path: ContextPath,
    spec: ContextRendererSpec,
): ContextTreeState {
    return { ...state, renderers: { ...state.renderers, [path]: spec } };
}

/** 取渲染声明（缺省 yaml —— 未声明即结构化值 dump） */
export function rendererOf(state: ContextTreeState, path: ContextPath): ContextRendererSpec {
    return state.renderers[path] ?? { renderer: "yaml" };
}

/** 值树里 path 处是否有值（`undefined` 视为无 —— 与「有值且为 null」区分开） */
export function hasValue(state: ContextTreeState, path: ContextPath): boolean {
    return getValue(state, path) !== undefined;
}

/** 单节点的值 hash（valueHash 的来源；模板节点按其 source 参与） */
export function valueHashOf(state: ContextTreeState, path: ContextPath): string {
    const spec = state.renderers[path];
    if (spec?.renderer === "template") return hashValue(spec.source);
    return hashValue(getValue(state, path));
}

// ─── places ────────────────────────────────────────────

export type PlacesValidation =
    | { ok: true; places: ContextPath[] }
    | { ok: false; reason: "invalid-path" | "duplicate" | "overlap"; detail: string };

/**
 * places 校验（144 用例 6）：每条都是合法路径、不重复、**两两不可互为祖先/后代**。
 * 割点集合若重叠，"这个节点属于哪个 place"就没有唯一答案，投递边界失效。
 */
export function validatePlaces(places: readonly ContextPath[]): PlacesValidation {
    const seen = new Set<ContextPath>();
    for (const p of places) {
        if (!isValidPath(p)) return { ok: false, reason: "invalid-path", detail: p };
        if (seen.has(p)) return { ok: false, reason: "duplicate", detail: p };
        seen.add(p);
    }
    const sorted = [...places].sort();
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            if (isAncestor(sorted[i], sorted[j])) {
                return { ok: false, reason: "overlap", detail: `${sorted[i]} ⊃ ${sorted[j]}` };
            }
        }
    }
    return { ok: true, places: sorted };
}

/**
 * path 归属哪个 place：取「是 path 祖先或自身」的**最长** place。
 * 无 place 覆盖时返回 null（该节点不参与投递 —— 144：places 是唯一投递配置）。
 */
export function placeOf(state: ContextTreeState, path: ContextPath): ContextPath | null {
    let best: ContextPath | null = null;
    for (const p of state.places) {
        if (p === path || isAncestor(p, path)) {
            if (best === null || p.length > best.length) best = p;
        }
    }
    return best;
}

/** 某容器下的 place 列表（字典序，保证 golden 稳定） */
export function placesIn(state: ContextTreeState, container: ContextContainer): ContextPath[] {
    return state.places.filter((p) => (state.placement[p] ?? "runtime") === container).sort();
}

/** 值树里 path 处是否是普通对象（值树合并/渲染的分支判据） */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
