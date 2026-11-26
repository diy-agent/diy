// units.test.ts —— 需求账本树的派生量（`unitBoard`）：树形、母项派生、ready。
//
// 2026-11-25 裁：账本只记「要做什么」。依赖边 / 分层 / 兄弟串行 / 交付批次整体删掉，
// 所以这里不再有「谁挡住谁」「第几层」这类判据 —— 只钉三件事：
//   · 父链 = 树（先序 + depth），脏数据（悬空父 / 父链成环）降级成根而不是崩
//   · ready = 叶子且 open（账本里「还没做的」就是能挑的，没有前置判定）
//   · 母项（有子）的状态由子派生（全 done → done），且不进 ready / doing
import { describe, expect, it } from 'vitest';

import { unitBoard, unitTreeLines, type UnitFacts } from '../src/units';

/** 造一个节点（board 只用 id / title / status / seq / parent；其余字段有缺省） */
function unit(
    id: string,
    status: UnitFacts['status'] = 'open',
    seq = Number(id.replace(/\D/g, '') || 0),
    parent: string | null = null,
): UnitFacts {
    // 验收口径缺省给一个：`unitTreeLines` 会给「缺验收」的叶子加行尾标记，
    // 不带的用例请显式传 ''（见「缺验收」那条）
    return { id, title: `标题 ${id}`, status, seq, parent, accept: '验收：能指出一个具体行为' };
}

describe('unitBoard：一棵需求账本树', () => {
    it('树是先序：根按 seq、子按 seq，depth 逐层 +1', () => {
        const board = unitBoard([unit('u1'), unit('u2', 'open', 2, 'u1'), unit('u3', 'open', 3, 'u1'), unit('u4')]);
        expect(board.rows.map((row) => [row.id, row.depth])).toEqual([
            ['u1', 0],
            ['u2', 1],
            ['u3', 1],
            ['u4', 0],
        ]);
        expect(board.roots).toEqual(['u1', 'u4']);
        expect(board.groups).toEqual(['u1']);
    });

    it('ready = 叶子且 open：账本里没有前置判定，兄弟也都能挑', () => {
        const board = unitBoard([unit('u1'), unit('u2')]);
        expect(board.ready).toEqual(['u1', 'u2']);
        expect(board.done).toEqual([]);
    });

    it('母项不进 ready / doing：它是分组，不是可执行条目', () => {
        const board = unitBoard([unit('dom'), unit('a', 'open', 2, 'dom'), unit('b', 'open', 3, 'dom')]);
        expect(board.ready).toEqual(['a', 'b']);
        expect(board.doing).toEqual([]);
    });

    it('doing 是独立一档：只出现在 doing 里，不混进 ready', () => {
        const board = unitBoard([unit('u1', 'doing'), unit('u2', 'open', 2)]);
        expect(board.doing).toEqual(['u1']);
        expect(board.ready).toEqual(['u2']);
    });

    it('母项状态由子派生：全 done → done，否则 open；落库的 status 不参与', () => {
        const done = unitBoard([unit('dom', 'open'), unit('a', 'done', 2, 'dom')]);
        expect(done.done).toEqual(['dom', 'a']);
        expect(done.rows[0]!.status).toBe('done');

        const mixed = unitBoard([unit('dom', 'done'), unit('a', 'done', 2, 'dom'), unit('b', 'open', 3, 'dom')]);
        expect(mixed.rows[0]!.status).toBe('open');
        expect(mixed.ready).toEqual(['b']);
    });

    it('悬空父（父不在图上）当根处理，并点名报出来 —— 脏数据不制造幽灵节点', () => {
        const board = unitBoard([unit('u2', 'open', 2, 'ghost')]);
        expect(board.rows.map((row) => row.id)).toEqual(['u2']);
        expect(board.rows[0]!.parent).toBeNull();
        expect(board.danglingParents).toEqual(['u2']);
    });

    it('父链成环（脏数据）只断一处，不无限递归', () => {
        const board = unitBoard([
            { id: 'a', title: 'A', status: 'open', seq: 1, parent: 'b' },
            { id: 'b', title: 'B', status: 'open', seq: 2, parent: 'a' },
        ]);
        // 断在哪一条不必规定（取决于遍历顺序），判据是：两个节点都还在、恰好一个成了根、环被点名
        expect(board.rows).toHaveLength(2);
        expect(board.roots).toHaveLength(1);
        expect(board.danglingParents).toHaveLength(1);
        expect(board.danglingParents[0]).toBe(board.roots[0]);
    });

    it('自己当自己的父：当根处理', () => {
        const board = unitBoard([unit('a', 'open', 1, 'a')]);
        expect(board.rows[0]!.parent).toBeNull();
        expect(board.danglingParents).toEqual(['a']);
    });
});

describe('unitTreeLines：模型读到的缩进树', () => {
    it('一行一个节点：缩进表层级，标记 x / > / ~ / 空', () => {
        const board = unitBoard([
            unit('dom'),
            unit('a', 'done', 2, 'dom'),
            unit('b', 'doing', 3, 'dom'),
            unit('c', 'open', 4, 'dom'),
        ]);
        expect(unitTreeLines(board)).toEqual([
            '- [ ] 标题 dom (dom)',
            '  - [x] 标题 a (a)',
            '  - [~] 标题 b (b)',
            '  - [>] 标题 c (c)',
        ]);
    });

    it('withBody 时把 body 接在行尾（不进上下文，只给需要看的人）', () => {
        const board = unitBoard([
            { id: 'a', title: 'A', status: 'open', seq: 1, body: '背景：用户报的导出缺失', accept: '导出点一下真落文件' },
        ]);
        expect(unitTreeLines(board, { withBody: true })).toEqual(['- [>] A (a)  body: 背景：用户报的导出缺失']);
    });

    it('叶子缺验收口径 ⇒ 行尾标「缺验收」（母项不标）', () => {
        const board = unitBoard([
            { id: 'g', title: '母项', status: 'open', seq: 1, parent: null, accept: '' },
            { id: 'a', title: 'A', status: 'open', seq: 2, parent: 'g', accept: '' },
            { id: 'b', title: 'B', status: 'open', seq: 3, parent: 'g', accept: '有单测' },
        ]);
        expect(unitTreeLines(board)).toEqual(['- [ ] 母项 (g)', '  - [>] A (a)  缺验收', '  - [>] B (b)']);
    });
});
