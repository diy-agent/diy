import { describe, expect, it } from 'vitest';
import { unitBoard, type UnitFacts } from '../src/units';

/** 造一个节点（board 只用 id / title / status / seq；其余字段有缺省） */
function unit(id: string, status: UnitFacts['status'] = 'open', seq = Number(id.slice(1))): UnitFacts {
    return { id, title: `标题 ${id}`, status, seq };
}

describe('unitBoard', () => {
    it('没有依赖的节点全部 ready，且都在第 0 层', () => {
        const board = unitBoard([unit('u1'), unit('u2')], []);
        expect(board.ready).toEqual(['u1', 'u2']);
        expect(board.blocked).toEqual([]);
        expect(board.layers).toHaveLength(1);
        expect(board.cyclic).toBe(false);
    });

    it('前置没做完 → blocked；前置 done → ready（删前置解锁不在这里，在 store 的删边）', () => {
        const board = unitBoard([unit('u1', 'done'), unit('u2'), unit('u3')], [
            { from: 'u1', to: 'u2' },
            { from: 'u2', to: 'u3' },
        ]);
        expect(board.ready).toEqual(['u2']);
        expect(board.blocked).toEqual(['u3']);
        expect(board.done).toEqual(['u1']);
        // u3 的前置是 u2（未 done），不是传递到 u1
        expect(board.rows.find((row) => row.id === 'u3')?.deps).toEqual(['u2']);
    });

    it('按依赖分层：同层之间没有边', () => {
        const board = unitBoard(
            [unit('u1'), unit('u2'), unit('u3'), unit('u4')],
            [
                { from: 'u1', to: 'u3' },
                { from: 'u2', to: 'u3' },
                { from: 'u3', to: 'u4' },
            ],
        );
        expect(board.layers.map((layer) => layer.map((row) => row.id))).toEqual([['u1', 'u2'], ['u3'], ['u4']]);
        expect(board.rows.map((row) => row.layer)).toEqual([0, 0, 1, 2]);
    });

    it('doing 是独立一档，不混进 ready / blocked', () => {
        const board = unitBoard([unit('u1', 'doing'), unit('u2', 'open')], []);
        expect(board.doing).toEqual(['u1']);
        expect(board.ready).toEqual(['u2']);
    });

    it('悬空边（一端已不在图上）被忽略，不制造假阻塞', () => {
        const board = unitBoard([unit('u2')], [{ from: 'u1', to: 'u2' }]);
        expect(board.ready).toEqual(['u2']);
        expect(board.rows[0]!.deps).toEqual([]);
    });

    it('库被写脏出现环时：不算死循环，remaining 落到最后一层并亮 cyclic', () => {
        const board = unitBoard([unit('u1'), unit('u2'), unit('u3')], [
            { from: 'u1', to: 'u2' },
            { from: 'u2', to: 'u1' },
        ]);
        expect(board.cyclic).toBe(true);
        // u3 无入边照样分层；环上的两个叠在最后一层
        expect(board.rows.map((row) => row.id)).toEqual(['u3', 'u1', 'u2']);
        expect(board.layers).toHaveLength(2);
    });
});
