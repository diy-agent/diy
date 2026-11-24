// unitLayout —— 把 unit DAG 变成一张「有坐标的图」（纯函数，无 DOM）。
//
// 为什么单独抽出来：视图组件里算坐标就测不了（要 DOM、要 mock 尺寸），而坐标算错的表现是
// 「线穿框」「同层的两个节点错开一列」这类只有肉眼才发现的毛病。纯函数 + 单测能钉住判据。
//
// 布局用 dagre（`@dagrejs/dagre`），但**层不由它决定**：dagre 为了缩短边长会自己重排 rank，
// 实测把同一层的 u5/u6 拆成了两列（u6 更靠前，因为它有后继）。而「同层 = 可并行」是这张图
// 最要紧的一条信息（也是 `unitBoard()` 里 `layers` 的定义）—— 层被挪动，图就在骗人。
//
// 解法：给每条边设 `minlen = layer(to) - layer(from)`。这样 dagre 的 rank 约束被钉死在
// 服务端算好的层上（同层必然同 rank），同时也白拿了它的层内排序（降交叉）与折线路由。
import { Graph, layout } from '@dagrejs/dagre';

/** 一个 unit（与 `@diy-agent/entity-runtime` 的 `UnitBoardRow` 同形；UI 层不跨包拿类型） */
export interface UnitItem {
    id: string;
    title: string;
    body: string;
    status: 'open' | 'doing' | 'done';
    deps: string[];
    dependents: string[];
    layer: number;
}

export interface UnitBoard {
    rows: UnitItem[];
    ready: string[];
    doing: string[];
    blocked: string[];
    done: string[];
    layers: UnitItem[][];
    cyclic: boolean;
}

/** 节点框（`x`/`y` 是**中心**，与 dagre 一致；渲染时减半宽半高） */
export interface UnitNode extends UnitItem {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface UnitEdge {
    from: string;
    to: string;
    /** 折线点（首点贴在源框边缘、末点贴在目标框边缘，含跨层拐点） */
    points: Array<{ x: number; y: number }>;
}

export interface UnitLayerBand {
    layer: number;
    /** 该层所有节点的 y 范围（含节点高）—— TB 布局下层是一条**横向**的带 */
    y: number;
    height: number;
    /** 这一层最左 / 最右的 x（画带的底色时用，带本身横跨整张图） */
    x: number;
    width: number;
}

export interface UnitLayout {
    nodes: UnitNode[];
    edges: UnitEdge[];
    /** 内容总尺寸（含 margin） */
    width: number;
    height: number;
    /** 每一层的范围 —— 画背景分带（横向条带）+ 左侧层号 */
    bands: UnitLayerBand[];
}

/** 节点框尺寸。标题宽度上限 = `UNIT_NODE_W - 内侧留白`，由 `clipTitle` 保证不溢出 */
export const UNIT_NODE_W = 160;
export const UNIT_NODE_H = 36;
const MARGIN = 20;

/** 标题按字数粗截（SVG 的 `<text>` 不会自动省略号；中英混排按「宽字符算 1」估） */
export function clipTitle(title: string, max = 12): string {
    const chars = [...title];
    if (chars.length <= max) return title;
    return `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * 算布局。输入顺序不敏感；环上的节点也能画（dagre 用 `acyclicer: 'greedy'` 临时反向一条边，
 * 图不崩，环本身由调用方按 `board.cyclic` 显式提示）。
 */
export function layoutUnits(rows: readonly UnitItem[]): UnitLayout {
    if (rows.length === 0) return { nodes: [], edges: [], width: 0, height: 0, bands: [] };

    const byId = new Map(rows.map((row) => [row.id, row]));
    const g = new Graph();
    g.setGraph({
        // TB（层从上往下），不是 LR：这个视图挂在任务页 detail 区 —— 一块**窄高**的面板。
        // LR 的 8 层要横向铺开，适配后缩到 0.3 倍，字全糊了（实测）；TB 的宽度只取决于
        // 「同层最多几个节点」（通常 1~3），高度靠滚动/拖动，正好是面板的形状。
        rankdir: 'TB',
        // 层间距给足：跨层边要在两层之间拐弯，太窄会让折线贴着框走
        ranksep: 44,
        nodesep: 26,
        marginx: MARGIN,
        marginy: MARGIN,
        acyclicer: 'greedy',
    });
    for (const row of rows) g.setNode(row.id, { width: UNIT_NODE_W, height: UNIT_NODE_H });

    const edges: UnitEdge[] = [];
    for (const row of rows) {
        for (const from of row.deps) {
            const dep = byId.get(from);
            if (dep === undefined) continue; // 悬空边（脏数据）不画
            // minlen = 层差：把服务端的层钉进 dagre 的 rank 约束（见文件头）
            const minlen = Math.max(1, row.layer - dep.layer);
            g.setEdge(from, row.id, { minlen });
        }
    }
    layout(g);

    const nodes: UnitNode[] = rows.map((row) => {
        const label = g.node(row.id) as { x: number; y: number } | undefined;
        return {
            ...row,
            x: label?.x ?? MARGIN,
            y: label?.y ?? MARGIN,
            w: UNIT_NODE_W,
            h: UNIT_NODE_H,
        };
    });

    for (const row of rows) {
        for (const from of row.deps) {
            const edge = g.edge(from, row.id) as { points?: Array<{ x: number; y: number }> } | undefined;
            if (edge?.points === undefined || edge.points.length === 0) continue;
            edges.push({ from, to: row.id, points: edge.points.map((p) => ({ x: p.x, y: p.y })) });
        }
    }

    // 层带：同层节点的 y 必然相同（minlen 钉住）；横向范围取整张图的宽（带横跨全图）
    const bands: UnitLayerBand[] = [];
    for (const layer of [...new Set(rows.map((row) => row.layer))].sort((a, b) => a - b)) {
        const inLayer = nodes.filter((node) => node.layer === layer);
        if (inLayer.length === 0) continue;
        const minY = Math.min(...inLayer.map((node) => node.y)) - UNIT_NODE_H / 2;
        const maxY = Math.max(...inLayer.map((node) => node.y)) + UNIT_NODE_H / 2;
        const minX = Math.min(...inLayer.map((node) => node.x)) - UNIT_NODE_W / 2;
        const maxX = Math.max(...inLayer.map((node) => node.x)) + UNIT_NODE_W / 2;
        bands.push({ layer, y: minY, height: maxY - minY, x: minX, width: maxX - minX });
    }

    const graphLabel = g.graph() as { width?: number; height?: number };
    return {
        nodes,
        edges,
        width: graphLabel.width ?? 0,
        height: graphLabel.height ?? 0,
        bands,
    };
}

/**
 * 圆角折线：直折线看起来像电路图，拐点切一段圆弧更像流程图（纯视觉，不改路径走向）。
 *
 * 为什么放在这个文件：它是布局的最后一小步（把点集变成 `d`），跟着布局一起测最省事；
 * 留在组件里就只能靠肉眼验「拐角是不是圆」。
 */
export function edgePath(points: ReadonlyArray<{ x: number; y: number }>, radius = 7): string {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1];
        const corner = points[i];
        const next = points[i + 1];
        const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
        const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
        if (inLen === 0 || outLen === 0) continue;
        const r = Math.min(radius, inLen / 2, outLen / 2);
        const before = {
            x: corner.x - ((corner.x - prev.x) / inLen) * r,
            y: corner.y - ((corner.y - prev.y) / inLen) * r,
        };
        const after = {
            x: corner.x + ((next.x - corner.x) / outLen) * r,
            y: corner.y + ((next.y - corner.y) / outLen) * r,
        };
        d += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`;
    }
    const last = points[points.length - 1];
    return `${d} L ${last.x} ${last.y}`;
}

/**
 * 焦点节点 + 它的**全部祖先与后代**（hover 时最想问「这条链上是谁」）。
 *
 * 必须是有向的（向上只走 `deps`、向下只走 `dependents`）。第一版把 `deps` 和 `dependents`
 * 混在一起做无向 BFS，结果从 u5 往上到 u4 就顺路走到了兄弟 u6/u7 —— 整张图连成一片，
 * 高亮等于没做（真实图上实测出来的）。
 */
export function chainOf(rows: readonly UnitItem[], id: string): Set<string> {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const seen = new Set<string>([id]);

    const up = [id];
    while (up.length > 0) {
        const cur = byId.get(up.pop()!);
        if (cur === undefined) continue;
        for (const dep of cur.deps) {
            if (seen.has(dep)) continue;
            seen.add(dep);
            up.push(dep);
        }
    }

    const down = [id];
    while (down.length > 0) {
        const cur = byId.get(down.pop()!);
        if (cur === undefined) continue;
        for (const next of cur.dependents) {
            if (seen.has(next)) continue;
            seen.add(next);
            down.push(next);
        }
    }

    return seen;
}
