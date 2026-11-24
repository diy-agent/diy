// unitLayout.test.ts —— 布局纯函数的判据（不需要 DOM）。
//
// 为什么值得单独测：坐标算错的三种典型表现全是「只有肉眼看图才发现」的 ——
//   1. 同层的两个节点**错开一列**（dagre 默认会为了缩短边长这么干，见 unitLayout.ts 文件头）；
//   2. 边从框中间穿过去（首末点没贴在框边缘）；
//   3. 跨层长边没有拐点，直接斜穿别人的框。
// 这个文件把这三条钉成断言。
import { describe, expect, it } from 'vitest';

import { chainOf, clipTitle, edgePath, layoutUnits, UNIT_NODE_H, UNIT_NODE_W, type UnitItem } from '../src/unitLayout';

/** 造一行 unit（只给布局用得上的字段；body 与 dependents 由 deps 反推） */
function row(id: string, deps: string[], layer: number, title = `步骤 ${id}`): UnitItem {
    return { id, title, body: '', status: 'open', deps, dependents: [], layer };
}

/**
 * lab 里真实那张图（t-001）：u1→u2→u3→u4→{u5, u6→u7}→u8→u9
 *
 * 层由服务端 `unitBoard()` 的 Kahn 算：u5 与 u6 同在第 5 层（都能在 u4 之后立刻做），
 * 但 u6 还有后继 u7、u5 直接接 u8 —— 正是这个形状会被 dagre 默认 ranker 拆成两列。
 */
const REAL: UnitItem[] = [
    row('u1', [], 0),
    row('u2', ['u1'], 1),
    row('u3', ['u2'], 2),
    row('u4', ['u3'], 3),
    row('u5', ['u4'], 4),
    row('u6', ['u4'], 4),
    row('u7', ['u6'], 5),
    row('u8', ['u5', 'u7'], 6),
    row('u9', ['u8'], 7),
];

describe('layoutUnits', () => {
    it('空图：什么都不产（视图自己说「还没有拆分」）', () => {
        expect(layoutUnits([])).toEqual({ nodes: [], edges: [], width: 0, height: 0, bands: [] });
    });

    it('同层必然同一行 —— 「同一层 = 可以并行」是这张图最要紧的信息', () => {
        const layout = layoutUnits(REAL);
        const byLayer = new Map<number, number[]>();
        for (const node of layout.nodes) {
            const list = byLayer.get(node.layer) ?? [];
            list.push(node.y);
            byLayer.set(node.layer, list);
        }
        for (const [layer, ys] of byLayer) {
            expect(new Set(ys).size, `第 ${layer + 1} 层被拆成了多行：${ys.join(',')}`).toBe(1);
        }
        // 层号越大越靠下（TB）
        const layers = [...byLayer.keys()].sort((a, b) => a - b);
        for (let i = 1; i < layers.length; i += 1) {
            expect(byLayer.get(layers[i])![0]).toBeGreaterThan(byLayer.get(layers[i - 1])![0]);
        }
    });

    it('每条依赖都画一条边，且首末点恰好落在框边界上（不从框中间穿出去）', () => {
        const layout = layoutUnits(REAL);
        const depCount = REAL.reduce((sum, item) => sum + item.deps.length, 0);
        expect(layout.edges).toHaveLength(depCount);

        // 判据：端点到中心的归一化距离 max(|dx|/半宽, |dy|/半高) ≈ 1 ——
        // 正对的边落在左右沿，斜向的边落在上下沿（这是对的，别写成「必须在右边界」）
        const onBorder = (box: { x: number; y: number }, point: { x: number; y: number }): number =>
            Math.max(Math.abs(point.x - box.x) / (UNIT_NODE_W / 2), Math.abs(point.y - box.y) / (UNIT_NODE_H / 2));

        const centerOf = new Map(layout.nodes.map((node) => [node.id, node]));
        for (const edge of layout.edges) {
            const from = centerOf.get(edge.from)!;
            const to = centerOf.get(edge.to)!;
            expect(onBorder(from, edge.points[0])).toBeCloseTo(1, 1);
            expect(onBorder(to, edge.points[edge.points.length - 1])).toBeCloseTo(1, 1);
        }
    });

    it('跨层长边绕开中间层（u5→u8 跨两层，横向要经过 u6/u7 所在的那一列）', () => {
        const layout = layoutUnits(REAL);
        const long = layout.edges.find((edge) => edge.from === 'u5' && edge.to === 'u8');
        expect(long).toBeDefined();
        expect(long!.points.length).toBeGreaterThan(2);
        // 拐点 y 落在一个中间层的行上（绕行，而不是斜穿）
        const u7 = layout.nodes.find((node) => node.id === 'u7')!;
        const crosses = long!.points.some((point) => Math.abs(point.y - u7.y) < 1);
        expect(crosses).toBe(true);
        // 相邻两层的边是一条直线（所有点同 x），不拐弯
        const adjacent = layout.edges.find((edge) => edge.from === 'u1' && edge.to === 'u2')!;
        expect(new Set(adjacent.points.map((point) => point.x)).size).toBe(1);
    });

    it('坐标都是有限数（NaN/undefined 会让整张图不显示）', () => {
        const layout = layoutUnits(REAL);
        expect(layout.width).toBeGreaterThan(0);
        expect(layout.height).toBeGreaterThan(0);
        for (const node of layout.nodes) {
            expect(Number.isFinite(node.x)).toBe(true);
            expect(Number.isFinite(node.y)).toBe(true);
        }
        for (const band of layout.bands) {
            expect(Number.isFinite(band.x)).toBe(true);
            expect(band.width).toBeGreaterThan(0);
        }
    });

    it('孤立节点也在图上（有坐标、不占边）', () => {
        const layout = layoutUnits([row('a', [], 0), row('b', ['a'], 1), row('solo', [], 0)]);
        expect(layout.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'solo']);
        expect(layout.edges).toHaveLength(1);
        const solo = layout.nodes.find((node) => node.id === 'solo')!;
        expect(Number.isFinite(solo.x)).toBe(true);
    });

    it('悬空边（端点不在图上）不画 —— 脏数据不能让整张图炸掉', () => {
        const layout = layoutUnits([row('b', ['ghost'], 0)]);
        expect(layout.edges).toHaveLength(0);
        expect(layout.nodes).toHaveLength(1);
    });

    it('环图不抛（dagre 贪心反向一条边），节点全在', () => {
        const cyclic = [row('a', ['c'], 0), row('b', ['a'], 1), row('c', ['b'], 2)];
        const layout = layoutUnits(cyclic);
        expect(layout.nodes).toHaveLength(3);
        expect(layout.edges).toHaveLength(3);
    });

    it('层带覆盖该层节点的完整高度（TB 下层是一条横带）', () => {
        const layout = layoutUnits(REAL);
        for (const band of layout.bands) {
            const layerNodes = layout.nodes.filter((node) => node.layer === band.layer);
            for (const node of layerNodes) {
                expect(node.y - UNIT_NODE_H / 2).toBeGreaterThanOrEqual(band.y - 0.01);
                expect(node.y + UNIT_NODE_H / 2).toBeLessThanOrEqual(band.y + band.height + 0.01);
                expect(node.x - UNIT_NODE_W / 2).toBeGreaterThanOrEqual(band.x - 0.01);
                expect(node.x + UNIT_NODE_W / 2).toBeLessThanOrEqual(band.x + band.width + 0.01);
            }
        }
    });
});

describe('chainOf', () => {
    /** 给真实图补上 dependents（布局不关心，链要高亮要用） */
    const withDependents = REAL.map((item) => ({
        ...item,
        dependents: REAL.filter((other) => other.deps.includes(item.id)).map((other) => other.id),
    }));

    it('焦点节点 + 有向的祖先与后代，**不含兄弟分支**', () => {
        // u5 的链 = 向上 u4 u3 u2 u1 + 自己 + 向下 u8 u9；u6/u7 是兄弟分支，不该亮
        expect([...chainOf(withDependents, 'u5')].sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u8', 'u9']);
    });

    it('源节点的链 = 它的整条下游；汇节点的链 = 整条上游', () => {
        expect([...chainOf(withDependents, 'u1')].sort()).toEqual(REAL.map((item) => item.id).sort());
        expect([...chainOf(withDependents, 'u9')].sort()).toEqual(REAL.map((item) => item.id).sort());
    });

    it('孤立节点只有自己', () => {
        expect([...chainOf([...withDependents, row('solo', [], 0)], 'solo')]).toEqual(['solo']);
    });
});

describe('clipTitle', () => {
    it('短标题原样返回，长的截断加省略号（SVG text 不会自动省略）', () => {
        expect(clipTitle('写单测')).toBe('写单测');
        // 12 字上限：11 个字 + 省略号
        expect(clipTitle('一二三四五六七八九十一二三四五六七八')).toBe('一二三四五六七八九十一…');
    });
});

describe('edgePath', () => {
    it('两点 = 直线；拐点处用 Q 倒角', () => {
        expect(edgePath([])).toBe('');
        expect(edgePath([{ x: 0, y: 0 }])).toBe('M 0 0');
        expect(edgePath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M 0 0 L 10 0');
        const bent = edgePath([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
        expect(bent.startsWith('M 0 0 L ')).toBe(true);
        expect(bent).toContain(' Q 10 0 ');
        expect(bent.endsWith('L 10 10')).toBe(true);
    });

    it('倒角半径不超过半边长（极短的一段不会被圆角吃掉）', () => {
        const path = edgePath(
            [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 1, y: 1 },
            ],
            7,
        );
        // 半径被压到 0.5：倒角起点 = (0.5, 0)
        expect(path).toContain('L 0.5 0');
    });
});
