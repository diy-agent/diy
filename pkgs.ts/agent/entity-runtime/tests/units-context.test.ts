// unitsContextText —— 模型读到的 `units` 节原文。
//
// 这一层最容易出的事不是「算错」，而是**两个消费者各拼一份**：界面「文本」tab 显示一份、
// 上下文注入另一份，人核对时看到的是假的原文。所以这里钉三条：
//   · 原文里确实是 YAML 的 `units:` 节（而不是某种近似表达）
//   · 超过硬线时退化摘要，`mode` 说得出来（界面要能解释「为什么模型只看到 ready」）
//   · 空树 = 整节缺席（`mode: 'empty'`，不是一段空 YAML）
import { describe, expect, it } from 'vitest';

import { unitsContextText, unitsContextValue, unitBoard, type UnitFacts } from '../src/units';

function unit(
    id: string,
    status: UnitFacts['status'] = 'open',
    seq = Number(id.replace(/\D/g, '') || 0),
    parent: string | null = null,
): UnitFacts {
    return { id, title: `标题 ${id}`, status, seq, parent };
}

describe('unitsContextText：给模型看的那段文本', () => {
    it('空树 → 整节缺席（empty，text 为空串）', () => {
        const board = unitBoard([], []);
        const out = unitsContextText(board, []);
        expect(out).toEqual({ text: '', chars: 0, mode: 'empty', treeLines: 0 });
    });

    it('正常树 → YAML 的 units 节，行数与字符数对得上', () => {
        const board = unitBoard([unit('u1'), unit('u2')], []);
        const out = unitsContextText(board, []);
        expect(out.mode).toBe('full');
        expect(out.treeLines).toBe(2);
        expect(out.chars).toBe(out.text.length);
        // 键名就是 schema 的键：模型读到的不是另一套词
        expect(out.text.startsWith('units:\n')).toBe(true);
        expect(out.text).toContain('ready:');
        expect(out.text).toContain('tree:');
        // 值确实是同一份算法的产物（不是另写一遍）
        const value = unitsContextValue(board, []);
        expect(out.text).toContain(`- [>] 标题 u1 (u1)`);
        expect(value?.ready.map((head) => head.id)).toEqual(['u1']);
    });

    it('超过 40 行 → 退化成摘要，mode 说得出来', () => {
        const rows = Array.from({ length: 45 }, (_, index) => unit(`u${index + 1}`, 'open', index + 1));
        const board = unitBoard(rows, []);
        const out = unitsContextText(board, []);
        expect(out.mode).toBe('summary');
        expect(out.treeLines).toBe(0);
        expect(out.text).not.toContain('tree:');
        expect(out.text).toContain('counts:');
        expect(out.text).toContain('只给现在能做的');
    });
});
