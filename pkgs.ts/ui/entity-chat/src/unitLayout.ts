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

/**
 * 一个 unit（与 `@diy-agent/entity-runtime` 的 `UnitBoardRow` 同形；UI 层不跨包拿类型）。
 *
 * 两套位置字段并存，各管一件事（2026-11-24）：
 *   · `parent` / `children` / `depth` = **分解树**（域 → 可验收的产出），列表视图按它缩进；
 *   · `deps` / `layer` = **执行依赖**，图视图按层摆（同层可并行）。
 */
export interface UnitItem {
    id: string;
    title: string;
    body: string;
    /** **有效**状态：叶子 = 落库值；功能域（有子）= 由子派生（全 done → done） */
    status: 'open' | 'doing' | 'done';
    parent: string | null;
    children: string[];
    /** 有子 = 功能域容器（本身不执行，不进 ready） */
    group: boolean;
    depth: number;
    deps: string[];
    dependents: string[];
    layer: number;
    /** 所属**交付批次**的 id；`null` = 未分批。与 parent / deps 正交 */
    batch: string | null;
}

export interface UnitBoard {
    /** **树的先序**：照着顺序缩进就是树 */
    rows: UnitItem[];
    roots: string[];
    ready: string[];
    doing: string[];
    blocked: string[];
    done: string[];
    groups: string[];
    /** 叶子被谁挡着（兄弟串行也在这里报，它不是 deps 边） */
    heldBy: Record<string, string>;
    layers: UnitItem[][];
    cyclic: boolean;
    /** 交付批次（旧服务端不返回 = 界面不显示批次那一条，不报错） */
    batches?: UnitBatchItem[];
}

/**
 * 一个交付批次在界面上的样子（与 `unitBatchViews` 同形，只取界面用得到的）。
 *
 * `stage` 不是存下来的状态：它是「成员做到哪了」的派生 —— 所以界面上不该出现
 * 「批次已完成」这种手改开关，只有 `accepted`（人验收过）是真实发生过的动作。
 */
export interface UnitBatchItem {
    id: string;
    title: string;
    note: string;
    /** 对齐服务端视图；当前摘要条暂不展示验收时间 */
    acceptedAt: number | null;
    stage: 'empty' | 'todo' | 'active' | 'review' | 'accepted';
    /** 这批里现在能开工的成员 */
    ready: string[];
    /** 挡住本批的批外节点 */
    waitingOn: string[];
    total: number;
    doneCount: number;
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

/**
 * 一个交付批次在图上的包围盒（画成虚框）。
 *
 * 为什么按 `batch` 画而不是按 `parent`：批次是**横切**分解树的（「一次 diff 能不能看懂」），
 * 同一批的节点可能散在好几层、甚至不同子树下 —— 那正是图上才看得见、列表里看不出的信息。
 */
export interface UnitBatchHull {
    batch: string;
    /** 框进来的节点（按传入顺序） */
    members: string[];
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 虚框比节点外沿再放宽一点，不然线和框贴在一起像「节点加粗了」 */
export const BATCH_HULL_PAD = 8;

/**
 * 把同 `batch` 的节点圈成包围盒（纯函数，`null` = 未分批不进框）。
 *
 * 用包围盒而不是凸包：成员会跨层，凸包在这种「竖直长条」形状下退化成近乎矩形，
 * 多算的那点面积换不来可读性；而包围盒的边永远是横平竖直的，和层带对得上。
 * 代价是**两个批次的节点交错时会互相套住**（框重叠）—— 所以节点上另有同色角标，
 * 重叠时仍能认出每个节点属于哪一批。
 */
export function batchHulls(nodes: readonly UnitNode[], pad = BATCH_HULL_PAD): UnitBatchHull[] {
    const groups = new Map<string, UnitNode[]>();
    for (const node of nodes) {
        if (node.batch === null || node.batch === '') continue;
        const list = groups.get(node.batch);
        if (list === undefined) groups.set(node.batch, [node]);
        else list.push(node);
    }
    // 按 batch id 排序 = 颜色分配稳定（同一批次的颜色不该随数据顺序跳变）
    return [...groups.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([batch, list]) => {
            const minX = Math.min(...list.map((node) => node.x - node.w / 2)) - pad;
            const maxX = Math.max(...list.map((node) => node.x + node.w / 2)) + pad;
            const minY = Math.min(...list.map((node) => node.y - node.h / 2)) - pad;
            const maxY = Math.max(...list.map((node) => node.y + node.h / 2)) + pad;
            return { batch, members: list.map((node) => node.id), x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        });
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
