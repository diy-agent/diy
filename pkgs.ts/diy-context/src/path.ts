// src/shared/context/path.ts
// 🎯 ContextPath 的解析与关系判断（纯函数）。
//
// 为什么单独一层：places 校验、patch 边界、父节点 hash 聚合三处都要判「谁是谁的祖先」，
// 三处各写一次 startsWith 必然口径漂移（`a` vs `ab` 的前缀误判是经典坑）。

import type { ContextPath } from "./types";

/**
 * 路径段的两种写法（JSONPath 风格，与 YAML 的键写法一致）：
 *   · 裸段：`[A-Za-z0-9_$-]+`（常见情形，可读性最好）
 *   · 键索引：`['...']` / `["..."]` —— 键含 `.` `/` 等特殊字符时用
 *     例：`chain['~/git/diy/AGENTS.md'].content`
 *
 * 为什么需要键索引：map 化的集合（如 AGENTS.md 链）用**稳定键**寻址 —— 键是文件路径，
 * 必然含 `.` 与 `/`。用下标寻址（`chain.0`）时链里插一个文件后面全部位移，
 * 无法表达"哪个文件变了"（144 结论：寻址必须用稳定 ID，禁止数组下标）。
 * 写法选 JSONPath 风格：与"用 jsonpath 告诉 LLM 哪个节点变了"的目标同一套表达。
 */
const BARE_SEG_RE = /^[A-Za-z0-9_$-]+$/;

/** 该段是否需要键索引包裹（裸段字符集之外的一律要） */
export function needsQuoteSeg(seg: string): boolean {
    return !BARE_SEG_RE.test(seg);
}

/** 把一段编码成路径文本（需要时用 `['...']` 包裹 + 转义） */
export function quoteSeg(seg: string): string {
    if (!needsQuoteSeg(seg)) return seg;
    const body = seg.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `['${body}']`;
}

/**
 * 切段（真正的 tokenizer，不是 split(".")）。
 * 空串、空段（`a..b`）、未闭合引号、键索引后跟杂字符 → null（调用方决定报错还是丢弃）。
 */
export function parsePath(p: ContextPath): string[] | null {
    if (typeof p !== "string" || p.length === 0) return null;
    const segs: string[] = [];
    let i = 0;
    while (i < p.length) {
        let seg: string;
        if (p[i] === "[") {
            const q = p[i + 1];
            if (q !== "'" && q !== '"') return null; // 只支持带引号的键索引（不支持数组下标）
            let j = i + 2;
            let out = "";
            let closed = false;
            while (j < p.length) {
                const c = p[j]!;
                if (c === "\\") {
                    out += p[j + 1] ?? "";
                    j += 2;
                    continue;
                }
                if (c === q) {
                    closed = true;
                    j++;
                    break;
                }
                out += c;
                j++;
            }
            if (!closed || p[j] !== "]") return null;
            seg = out;
            i = j + 1;
        } else {
            let j = i;
            while (j < p.length && p[j] !== "." && p[j] !== "[") j++;
            seg = p.slice(i, j);
            if (!BARE_SEG_RE.test(seg)) return null; // 裸段必须落在字符集内（`a b` 非法）
            i = j;
        }
        if (seg.length === 0) return null; // 空段（`a..b` / `['']`）
        // 段后必须是 `.`（下一段）或 `[`（键索引，无需分隔符）或结束
        if (p[i] !== undefined && p[i] !== "." && p[i] !== "[") return null;
        segs.push(seg);
        if (p[i] === ".") {
            if (i + 1 >= p.length) return null; // 尾部空段（`a.`）
            i++; // 跳过分隔符
        }
    }
    return segs.length > 0 ? segs : null;
}

export function isValidPath(p: ContextPath): boolean {
    return parsePath(p) !== null;
}

/** 段数组 → 路径文本（需要引号的段用 `['...']`；与 parsePath 严格互逆）。
 *  注意键索引段**不加前导 `.`**（`chain['a.md']` 而不是 `chain.['a.md']`）。 */
export function joinPath(segs: readonly string[]): ContextPath {
    let out = "";
    for (const seg of segs) {
        out += needsQuoteSeg(seg) ? quoteSeg(seg) : `${out ? "." : ""}${seg}`;
    }
    return out;
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
