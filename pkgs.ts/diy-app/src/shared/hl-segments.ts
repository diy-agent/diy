// src/shared/hl-segments.ts
// 🎯 把文本按高亮区间切成片段（预览高亮用）：[ [文本, 是否高亮], … ]
//
// 纯函数、不依赖 DOM（renderer 用，单测直接测）。区间来自 trace 的 out 区间（字符偏移）：
//   · 乱序/重叠区间要能合并（变量行 → 多处出现；:for 的父与迭代项天然重叠）
//   · 越界区间夹回文本范围（防御脏数据：引擎与 UI 版本不一致时不能白屏）

export interface HlRange {
    from: number;
    to: number;
}

export function splitByRanges(text: string, ranges: HlRange[]): Array<[string, boolean]> {
    const norm = ranges
        .map((r) => ({ from: Math.max(0, Math.min(r.from, text.length)), to: Math.max(0, Math.min(r.to, text.length)) }))
        .filter((r) => r.to > r.from)
        .sort((a, b) => a.from - b.from || a.to - b.to);
    const out: Array<[string, boolean]> = [];
    let cursor = 0;
    for (const r of norm) {
        const from = Math.max(r.from, cursor);
        const to = Math.max(r.to, from);
        if (to <= from) continue; // 完全被前一个区间盖住
        if (from > cursor) out.push([text.slice(cursor, from), false]);
        out.push([text.slice(from, to), true]);
        cursor = to;
    }
    if (cursor < text.length) out.push([text.slice(cursor), false]);
    return out;
}
