import { describe, expect, it } from 'vitest';
import { unitBoard, unitTreeLines, type UnitFacts } from '../src/units';

/** 造一个节点（board 只用 id / title / status / seq / parent；其余字段有缺省） */
function unit(
    id: string,
    status: UnitFacts['status'] = 'open',
    seq = Number(id.replace(/\D/g, '') || 0),
    parent: string | null = null,
): UnitFacts {
    return { id, title: `标题 ${id}`, status, seq, parent };
}

describe('unitBoard：树 = 分解，边 = 先后', () => {
    it('同父兄弟按书写顺序串行：只有第一个 ready，其余被前序兄弟挡着', () => {
        const board = unitBoard([unit('u1'), unit('u2')], []);
        expect(board.ready).toEqual(['u1']);
        expect(board.blocked).toEqual(['u2']);
        // 挡住它的是兄弟，不是依赖边 —— 这正是不画边的理由（`deps` 保持空）
        expect(board.heldBy['u2']).toBe('u1');
        expect(board.rows.find((row) => row.id === 'u2')?.deps).toEqual([]);
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
    });

    it('doing 是独立一档，不混进 ready / blocked', () => {
        const board = unitBoard([unit('u1', 'doing'), unit('u2', 'open')], []);
        expect(board.doing).toEqual(['u1']);
        // u2 是 u1 的后序兄弟：串行规则下它得等 u1 做完
        expect(board.ready).toEqual([]);
        expect(board.heldBy['u2']).toBe('u1');
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
        // rows 是**树**先序（无父 → 根 → 按 seq），跟依赖分层无关
        expect(board.rows.map((row) => row.id)).toEqual(['u1', 'u2', 'u3']);
        expect(board.layers).toHaveLength(2);
    });
});

describe('unitBoard：功能域（容器）', () => {
    // 域 d 下 a → b（兄弟串行）；域 e 下 c
    const tree = [
        unit('d', 'open', 1, null),
        unit('a', 'open', 2, 'd'),
        unit('b', 'open', 3, 'd'),
        unit('e', 'open', 4, null),
        unit('c', 'open', 5, 'e'),
    ];

    it('容器不进 ready / blocked / doing：可执行的只有叶子', () => {
        const board = unitBoard(tree, []);
        expect(board.groups).toEqual(['d', 'e']);
        expect(board.ready).toEqual(['a']);
        expect(board.blocked).toEqual(['b', 'c']);
        // 父 d 只是分组，不是「现在能做的一条」
        expect(board.ready).not.toContain('d');
    });

    it('rows 是树的先序 + depth：视图照这个顺序缩进就是树', () => {
        const board = unitBoard(tree, []);
        expect(board.rows.map((row) => row.id)).toEqual(['d', 'a', 'b', 'e', 'c']);
        expect(board.rows.map((row) => row.depth)).toEqual([0, 1, 1, 0, 1]);
        expect(board.rows.find((row) => row.id === 'd')?.children).toEqual(['a', 'b']);
        expect(board.roots).toEqual(['d', 'e']);
    });

    it('容器状态由子派生：子全 done → 父 done（父自己落库的 status 不参与）', () => {
        const board = unitBoard(
            [unit('d', 'open', 1, null), unit('a', 'done', 2, 'd'), unit('b', 'done', 3, 'd')],
            [],
        );
        expect(board.done).toEqual(['d', 'a', 'b']);
        expect(board.rows.find((row) => row.id === 'd')?.status).toBe('done');
    });

    it('域间串行：第二个域的叶子被第一个域的整棵子树挡着', () => {
        const board = unitBoard(
            [unit('d', 'open', 1, null), unit('a', 'done', 2, 'd'), unit('b', 'open', 3, 'd'), unit('e', 'open', 4, null), unit('c', 'open', 5, 'e')],
            [],
        );
        expect(board.ready).toEqual(['b']);
        expect(board.heldBy['c']).toBe('d');
    });

    it('跨域边：被支点挡住的叶子报出真正的依赖（优先于兄弟）', () => {
        const board = unitBoard(
            [unit('d', 'open', 1, null), unit('a', 'open', 2, 'd'), unit('e', 'open', 4, null), unit('c', 'open', 5, 'e')],
            [{ from: 'a', to: 'c' }],
        );
        expect(board.heldBy['c']).toBe('a');
        expect(board.rows.find((row) => row.id === 'c')?.deps).toEqual(['a']);
    });

    it('父指向不存在的 id：当根处理并报 danglingParents（并行调用的中间态）', () => {
        const board = unitBoard([unit('a', 'open', 1, 'ghost')], []);
        expect(board.roots).toEqual(['a']);
        expect(board.danglingParents).toEqual(['a']);
        expect(board.ready).toEqual(['a']);
    });

    it('父链成环（脏数据）：拆成根，不无限递归', () => {
        const board = unitBoard([unit('a', 'open', 1, 'b'), unit('b', 'open', 2, 'a')], []);
        expect(board.rows).toHaveLength(2);
        // 环被拆开一条（a 变根），图仍然是一棵能遍历的树；拆点报出来
        expect(board.danglingParents).toEqual(['a']);
        expect(board.roots).toEqual(['a']);
    });
});

describe('unitTreeLines：缩进文本（给人看、也进 system）', () => {
    it('缩进 = 层级，标记 = 状态，行尾带「等谁」', () => {
        const board = unitBoard(
            [unit('d', 'open', 1, null), unit('a', 'done', 2, 'd'), unit('b', 'open', 3, 'd')],
            [],
        );
        expect(unitTreeLines(board)).toEqual([
            '- [ ] 标题 d (d)',
            '  - [x] 标题 a (a)',
            '  - [>] 标题 b (b)',
        ]);
    });

    it('被挡住的叶子标出挡住它的 id', () => {
        // 域 d 下 a（先，还没做）、b（后）：b 被兄弟 a 挡着
        const board = unitBoard([unit('d', 'open', 1), unit('a', 'open', 2, 'd'), unit('b', 'open', 3, 'd')], []);
        expect(unitTreeLines(board)[2]).toBe('  - [.] 标题 b (b)  ← 等 a');
    });
});
