// src/shared/hl-lines.ts
// 🎯 区间 → 行号（试验场"整行高亮"用）
//
// 为什么按行高亮而不是按字符：调试时看的是"哪一行参与了"，
// 行背景能覆盖整行（含空白），比给一个 token 上色更容易扫读；
// 而且行号是两边（模版编辑器 / 预览）共同的定位基准。
//
// 纯函数（renderer 与单测共用）：一行内的任一区间都算整行；跨行区间算覆盖到的每一行。

export interface HlSpan {
    from: number;
    to: number;
}

/** 行号（1 基）：区间覆盖到的所有行，去重升序。空区间不产出行 */
export function lineNumbersOf(text: string, ranges: HlSpan[]): number[] {
    if (ranges.length === 0) return [];
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    /** 位置 → 行号（二分：lineStarts 单调） */
    const lineOf = (pos: number): number => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid]! <= pos) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
    const out = new Set<number>();
    for (const r of ranges) {
        const from = Math.max(0, Math.min(r.from, text.length));
        const to = Math.max(from, Math.min(r.to, text.length));
        if (to <= from) continue; // 空区间（这次没产出）不产出行
        const first = lineOf(from);
        const last = lineOf(to - 1);
        for (let n = first; n <= last; n++) out.add(n);
    }
    return [...out].sort((a, b) => a - b);
}
