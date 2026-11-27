// units-steps.test.ts —— 需求层 与 步骤层（2026-11-27 用户裁：只有根需求，步骤挂下面）
//
// 要钉住的不是「能存步骤」，而是**步骤不许挤进需求层**：
//   · `unitBoard` 的 rows / ready / doing / groups 只算 need；step 不出现在树里
//   · 步骤按 parent 聚到那条需求的 `steps` 上，并给出 `progress`
//   · 没挂父的 step 没有归属 → 不制造幽灵行（界面上就该看不见）
//   · 上下文（`unitsContextValue` / `unitTreeLines`）只注入需求层：步骤进去会把挑活淹掉
import { describe, expect, it } from 'vitest';

import { unitBoard, unitTreeLines, unitsContextValue, type UnitFacts } from '../src/units';

function need(id: string, extra: Partial<UnitFacts> = {}): UnitFacts {
    return { id, title: `需求 ${id}`, status: 'open', seq: Number(id.replace(/\D/g, '') || 1), accept: '有单测', ...extra };
}

function step(id: string, parent: string, status: UnitFacts['status'] = 'open', seq = 99): UnitFacts {
    return { id, kind: 'step', title: `步骤 ${id}`, status, seq, parent };
}

describe('步骤挂需求下，不进需求层', () => {
    it('step 不出现在 rows / ready / groups；需求仍是叶子（能挑）', () => {
        const board = unitBoard([need('u1'), step('s1', 'u1'), step('s2', 'u1', 'done')]);
        expect(board.rows.map((row) => row.id)).toEqual(['u1']);
        expect(board.ready).toEqual(['u1']);
        // 有步骤不等于「有子需求」—— 需求仍然可执行
        expect(board.groups).toEqual([]);
        expect(board.rows[0]?.group).toBe(false);
    });

    it('步骤聚到那条需求的 steps 上，并给 progress（done / total）', () => {
        const board = unitBoard([need('u1'), step('s1', 'u1', 'done'), step('s2', 'u1', 'doing')]);
        const row = board.rows[0]!;
        expect(row.steps.map((s) => [s.id, s.status])).toEqual([
            ['s1', 'done'],
            ['s2', 'doing'],
        ]);
        expect(row.progress).toEqual({ done: 1, total: 2 });
    });

    it('没有步骤的需求不带 progress（界面据此不画进度条）', () => {
        const board = unitBoard([need('u1')]);
        expect(board.rows[0]?.steps).toEqual([]);
        expect(board.rows[0]?.progress).toBeUndefined();
    });

    it('没挂父的 step 没有归属：不制造幽灵行，也不影响任何需求的进度', () => {
        const board = unitBoard([need('u1'), { ...step('orphan', 'nope'), parent: null }]);
        expect(board.rows.map((row) => row.id)).toEqual(['u1']);
        expect(board.rows[0]?.progress).toBeUndefined();
        expect(board.rows[0]?.steps).toEqual([]);
    });

    it('步骤自身的状态不参与需求状态派生（需求状态只看需求）', () => {
        const allStepsDone = unitBoard([need('u1'), step('s1', 'u1', 'done')]);
        expect(allStepsDone.rows[0]?.status).toBe('open');
        const needDone = unitBoard([need('u1', { status: 'done' }), step('s1', 'u1', 'open')]);
        expect(needDone.rows[0]?.status).toBe('done');
    });
});

describe('上下文只注入需求层', () => {
    it('unitTreeLines 不出现步骤（模型挑活看的是需求，不是执行清单）', () => {
        const board = unitBoard([need('u1'), step('s1', 'u1')]);
        expect(unitTreeLines(board)).toEqual(['- [>] 需求 u1 (u1)']);
    });

    it('unitsContextValue 的 ready 只有需求', () => {
        const board = unitBoard([need('u1'), step('s1', 'u1')]);
        expect(unitsContextValue(board)).toMatchObject({ ready: [{ id: 'u1', title: '需求 u1' }] });
    });
});
