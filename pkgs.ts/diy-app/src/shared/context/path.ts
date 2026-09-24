// src/shared/context/path.ts
// 🎯 ContextPath 的解析与关系判断（纯函数）。
//
// 为什么单独一层：places 校验、patch 边界、父节点 hash 聚合三处都要判「谁是谁的祖先」，
// 三处各写一次 startsWith 必然口径漂移（`a` vs `ab` 的前缀误判是经典坑）。

import type { ContextPath } from "./types";

/**
 * 路径段的字符集：字母数字 + `_` `$` `-`。
 * 不含 `.`（分隔符）与 `/`（会与模板路径语法冲突）—— 任务 URI 这类含 `/` 的值
 * 不作为路径段使用（144 结论：用稳定 ID，不用 `task.3.children.4` 这类位置路径）。
 */
const SEG_RE = /^[A-Za-z0-9_$-]+$/;

/** 切段：空串/前后多余点一律视为非法，返回 null（调用方决定报错还是丢弃） */
export function parsePath(p: ContextPath): string[] | null {
    if (typeof p !== "string" || p.length === 0) return null;
    const segs = p.split(".");
    for (const s of segs) if (!SEG_RE.test(s)) return null;
    return segs;
}

export function isValidPath(p: ContextPath): boolean {
    return parsePath(p) !== null;
}

export function joinPath(segs: readonly string[]): ContextPath {
    return segs.join(".");
}

/** a 是 b 的**严格**祖先（`a` 是 `a.b` 的祖先；`a` 不是 `a` 的祖先） */
export function isAncestor(a: ContextPath, b: ContextPath): boolean {
    if (a === b || a.length === 0) return false;
    return b.startsWith(`${a}.`);
}

/** a 是 b 或 b 的祖先（places 校验/子树收集用） */
export function isSelfOrAncestor(a: ContextPath, b: ContextPath): boolean {
    return a === b || isAncestor(a, b);
}

/** b 是否落在 a 的子树里（含自身） */
export function inSubtree(a: ContextPath, b: ContextPath): boolean {
    return isSelfOrAncestor(a, b);
}

/** 取父路径；顶层返回 null */
export function parentOf(p: ContextPath): ContextPath | null {
    const i = p.lastIndexOf(".");
    return i < 0 ? null : p.slice(0, i);
}

/** p 的所有祖先（由近到远），不含自身 */
export function ancestorsOf(p: ContextPath): ContextPath[] {
    const out: ContextPath[] = [];
    let cur = parentOf(p);
    while (cur) {
        out.push(cur);
        cur = parentOf(cur);
    }
    return out;
}
