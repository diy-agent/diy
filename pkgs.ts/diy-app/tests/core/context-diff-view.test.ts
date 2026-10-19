// tests/core/context-diff-view.test.ts
// 🎯 「行级 diff 的阅读形态」纯函数（##310 · 用户要的"像 vscode 那样看变化"）
//
// 测的都是**会骗人的地方**：行号（旧/新两根轴）、折叠（不能把改动折掉）、截断（不能假装没有了）。

import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../src/shared/line-diff';
import { foldCounts, foldDiff, numberDiff, type DiffRow } from '../../src/shared/context/diff-view';

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n');

describe('numberDiff —— 旧/新两根行号轴', () => {
    it('删除行只占旧行号，新增行只占新行号，未变行两侧同步推进', () => {
        const d = lineDiff('a\nb\nc', 'a\nX\nc');
        const n = numberDiff(d);
        expect(n.map((l) => [l.t, l.s, l.oldNo, l.newNo])).toEqual([
            [' ', 'a', 1, 1],
            ['-', 'b', 2, null],
            ['+', 'X', null, 2],
            [' ', 'c', 3, 3],
        ]);
    });
});

describe('foldDiff —— 折成 hunk（改动 ± 上下文，中间空隙折叠）', () => {
    it('没有改动 → 空（调用方据此显示"无实质变化"，而不是给一大坨原文）', () => {
        expect(foldDiff(lineDiff('a\nb', 'a\nb'))).toEqual([]);
    });

    it('只展开改动附近，前后折成两个空隙，且行数对得上', () => {
        const a = lines(20);
        const b = lines(20).replace('L10', 'L10-改');
        const rows = foldDiff(lineDiff(a, b), { context: 2 });
        const kinds = rows.map((r) => r.kind);
        expect(kinds).toEqual(['gap', 'line', 'line', 'line', 'line', 'line', 'line', 'gap']);
        const first = rows[0] as Extract<DiffRow, { kind: 'gap' }>;
        const last = rows[rows.length - 1] as Extract<DiffRow, { kind: 'gap' }>;
        expect(first.count).toBe(7); // L1..L7 被折
        expect(last.count).toBe(8); // L13..L20 被折
        // 展开的内容确实是改动行 + 两侧各 2 行
        const texts = rows.filter((r): r is Extract<DiffRow, { kind: 'line' }> => r.kind === 'line').map((r) => `${r.line.t}${r.line.s}`);
        expect(texts).toEqual([' L8', ' L9', '-L10', '+L10-改', ' L11', ' L12']);
    });

    it('相近的两处改动合并成一段（不出现只有几行的空隙）', () => {
        const a = lines(30);
        const b = lines(30).replace('L10', 'L10x').replace('L14', 'L14x');
        const rows = foldDiff(lineDiff(a, b), { context: 2 });
        expect(rows.filter((r) => r.kind === "gap").length).toBe(2); // 只有头尾两个空隙
    });

    it('空隙带稳定 id 与下标区间（UI 靠它把原文切回来）', () => {
        const a = lines(20);
        const b = lines(20).replace('L10', 'L10-改');
        const diff = lineDiff(a, b);
        const rows = foldDiff(diff, { context: 1 });
        const gap = rows[0] as Extract<DiffRow, { kind: 'gap' }>;
        expect(gap.fromIdx).toBe(0);
        expect(gap.id).toBe('gap:0');
        expect(diff.slice(gap.fromIdx, gap.toIdx + 1).length).toBe(gap.count);
    });

    it('超过渲染上限 → 截断（如实标 truncated，不假装后面没有了）', () => {
        const a = lines(100);
        const b = lines(100).replace('L50', 'L50x');
        const rows = foldDiff(lineDiff(a, b), { context: 40, maxLines: 10 });
        const tail = rows[rows.length - 1] as Extract<DiffRow, { kind: 'gap' }>;
        expect(tail.kind).toBe('gap');
        expect(tail.truncated).toBe(true);
        expect(rows.filter((r) => r.kind === 'line').length).toBeLessThanOrEqual(10);
    });
});

describe('foldCounts —— 列表里的一眼统计', () => {
    it('增/删/被折行数各归各', () => {
        const a = lines(20);
        const b = lines(20).replace('L20', 'L20x');
        const c = foldCounts(foldDiff(lineDiff(a, b), { context: 1 }));
        expect(c.add).toBe(1);
        expect(c.del).toBe(1);
        expect(c.gapLines).toBe(18);
    });
});
