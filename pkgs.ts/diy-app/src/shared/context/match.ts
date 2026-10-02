// src/shared/context/match.ts
// 🎯 结构树的路径 → 请求预览文本里的**匹配行区间**（纯函数，UI 选中联动用）。
//
// 为什么单独放这里：它是"树上的一个节点 ↔ 文本里的若干行"的对应规则，属于**寻址语义**
// （与渲染同源的那份行号映射配对使用），不是某个组件的私事；放 shared 才能单测。
//
// 三类匹配（缺一就会出现"点了没反应"）：
//   1. 精确：`diy.cli` 直接命中；
//   2. 通配：结构树里数组元素类型写作 `[ChainEntry]`（zod 派生的**元素名**，不是数据里的下标），
//      于是 `chain.[ChainEntry].scope` 要展开成 `chain.<数字>.scope` —— 否则选中集合元素的字段
//      永远定位不到（实测踩到）；
//   3. 前缀：容器行（如 `chain`）没有自己的值 → 取它所有后代。
//
// 相邻/重叠的区间**合并**：同一个元素的多行合成一段，避免"一个元素算 N 处"。

export interface LineRange {
    from: number;
    to: number;
}

/** 段是否数组元素名（`[ChainEntry]` / `[string]` / `[]`） */
const isElementSeg = (seg: string): boolean => /^\[[^\]]*\]$/.test(seg);

/** 正则元字符转义（路径段是数据，不能当正则） */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** path → 正则**源**（元素名段通配数字下标；未加锚） */
function patternSource(path: string): string {
    return path
        .split(".")
        .map((seg) => (isElementSeg(seg) ? "\\d+" : esc(seg)))
        .join("\\.");
}

/** path → 精确匹配整条 key 的正则（元素名段通配数字下标） */
export function pathPattern(path: string): RegExp {
    return new RegExp(`^${patternSource(path)}$`);
}

/**
 * 一个结构树 path 在行号映射里的**所有**匹配区间（按行号升序、已合并连片）。
 * 无匹配返回空数组（调用方据此决定"要不要显示导航条"）。
 */
export function matchRanges(
    lines: Record<string, LineRange>,
    path: string,
): LineRange[] {
    const exact = lines[path];
    if (exact) return [exact];
    // 两条模式：整条 key / 它的后代（前缀）—— 都按"元素名段通配"展开，
    // 否则带 `[ChainEntry]` 的路径既匹配不到元素本身、也匹配不到元素的字段
    const src = patternSource(path);
    const reExact = new RegExp(`^${src}$`);
    const reDesc = new RegExp(`^${src}\\.`);
    const hits = Object.entries(lines)
        .filter(([k]) => reExact.test(k) || reDesc.test(k))
        .map(([, v]) => v)
        .sort((a, b) => a.from - b.from);
    if (hits.length === 0) return [];
    // 合并相邻/重叠：next.from <= cur.to + 1 视为连片（同一元素的多行 → 一段）
    const merged: LineRange[] = [{ ...hits[0]! }];
    for (const h of hits.slice(1)) {
        const cur = merged[merged.length - 1]!;
        if (h.from <= cur.to + 1) cur.to = Math.max(cur.to, h.to);
        else merged.push({ ...h });
    }
    return merged;
}

/** 区间 → 行号列表（含首尾；给编辑器高亮用） */
export function lineRange(m: LineRange): number[] {
    return Array.from({ length: m.to - m.from + 1 }, (_, i) => m.from + i);
}
