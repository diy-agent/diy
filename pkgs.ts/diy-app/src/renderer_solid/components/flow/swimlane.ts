/**
 * swimlane.ts — 泳道图的**纯几何**（无 DOM、无 Solid，可单测）。
 *
 * 依据（##166 §14.5 / §14.2、##320 硬约束）：
 *  · 纵轴 = 流程推进方向（驻留序号自上而下），横带 = 泳道（= 节点，1:1）；
 *  · 打回**不新建节点** ⇒ 同一泳道会二次驻留 —— 图上就是同一列的第二行；
 *  · 连线三种形状与 demo 同款：同泳道直线 / 跨泳道 S 形 / 打回绕右侧通道；
 *  · **层叠一次性画清**：背景(0) → 连线(2) → 节点(3) —— 本文件只给几何，
 *    分层由 `FlowStage.tsx` 的 `LANE_Z / WIRE_Z / NODE_Z` 常量钉死（别再各自写 z-index）。
 */
import type { FlowEdgeKind, FlowLane, FlowVisitBrief } from "../../lib/flow-view";

/** 层叠序（唯一出处；FlowStage 的 DOM 按此上 z-index） */
export const LANE_Z = 0;
export const WIRE_Z = 2;
export const NODE_Z = 3;

/** 连线颜色：**两色**（订正 6 —— 只有「打回红虚线」当下有真数据；「系统自动推绿」本版无实现路径） */
export const WIRE_COLOR: Record<FlowEdgeKind, string> = {
    next: "#3b82f6",
    bounce: "#ef4444",
};

/** actor 色（表头小点；`agent` / `human` / `system` 是内核 `ACTORS` 全集） */
export const ACTOR_COLOR: Record<string, string> = {
    agent: "#3b82f6",
    human: "#f59e0b",
    system: "#10b981",
};

export interface SwimlaneGeom {
    /** 一条泳道的宽 */
    readonly laneW: number;
    /** 节点卡宽（居中于泳道） */
    readonly cardW: number;
    /** 节点卡高（**不含**产物区 —— 产物区画在卡下方，高由帧内内容决定，几何上预留 ART_H） */
    readonly cardH: number;
    /** 产物区预留高 */
    readonly artH: number;
    /** 相邻两行的留白 */
    readonly rowGap: number;
    /** 顶部表头高（泳道名 + 当前节点标注） */
    readonly topPad: number;
}

export const DEFAULT_GEOM: SwimlaneGeom = {
    laneW: 208,
    cardW: 168,
    cardH: 84,
    artH: 96,
    rowGap: 34,
    topPad: 40,
};

export interface StageLane {
    readonly node: string;
    readonly name: string;
    readonly named: boolean;
    readonly reached: boolean;
    readonly visits: number;
    /** 底纹左缘 */
    readonly x: number;
    readonly w: number;
}

export interface StageVisit {
    /** 折线下标（0-based） */
    readonly index: number;
    readonly visit: FlowVisitBrief;
    readonly lane: number;
    /** 节点卡左缘 / 上缘（**不含**表头） */
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface StageWire {
    readonly d: string;
    readonly kind: FlowEdgeKind;
    readonly from: number;
    readonly to: number;
    /** 标注落点（打回写「打回」；推进不写 —— demo 同款） */
    readonly label: { readonly x: number; readonly y: number; readonly text: string } | null;
}

export interface StageLayout {
    readonly width: number;
    readonly height: number;
    readonly lanes: readonly StageLane[];
    readonly visits: readonly StageVisit[];
    readonly wires: readonly StageWire[];
}

/** 相邻两次驻留之间的连线路径（三种形状，对齐 ##166 demo 的观感） */
function wirePath(
    a: { x: number; y: number; h: number },
    b: { x: number; y: number },
    kind: FlowEdgeKind,
    cardW: number,
): string {
    const x1 = a.x + cardW / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + cardW / 2;
    const y2 = b.y;
    if (kind === "bounce") {
        // 打回：绕右侧通道（红线虚线 + 箭头，见 FlowStage）
        return `M${x1},${y1} C${x1 + 86},${y1 + 16} ${x2 + 86},${y2 - 24} ${x2},${y2}`;
    }
    if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
    return `M${x1},${y1} C${x1},${y1 + 42} ${x2},${y2 - 42} ${x2},${y2}`;
}

/**
 * 由「泳道序列 + 折线」算出整张图的几何。
 *
 * `lanes` 的顺序即横向次序；`trajectory` 里每个节点都必须能在 `lanes` 里找到（deriveLanes 保证）。
 */
export function buildStage(
    lanes: readonly FlowLane[],
    trajectory: readonly FlowVisitBrief[],
    geom: SwimlaneGeom = DEFAULT_GEOM,
): StageLayout {
    const laneOf = new Map<string, number>();
    lanes.forEach((l, i) => laneOf.set(l.node, i));
    const step = geom.cardH + geom.artH + geom.rowGap;

    const stageLanes: StageLane[] = lanes.map((l, i) => ({
        node: l.node,
        name: l.name,
        named: l.named,
        reached: l.reached,
        visits: l.visits,
        x: i * geom.laneW + 2,
        w: geom.laneW - 4,
    }));

    const visits: StageVisit[] = trajectory.map((v, index) => {
        const lane = laneOf.get(v.node) ?? 0;
        return {
            index,
            visit: v,
            lane,
            x: lane * geom.laneW + (geom.laneW - geom.cardW) / 2,
            y: geom.topPad + index * step,
            w: geom.cardW,
            h: geom.cardH,
        };
    });

    const wires: StageWire[] = [];
    for (let i = 0; i + 1 < visits.length; i++) {
        const a = visits[i]!;
        const b = visits[i + 1]!;
        const kind = b.visit.kind;
        wires.push({
            d: wirePath(a, b, kind, geom.cardW),
            kind,
            from: i,
            to: i + 1,
            label:
                kind === "bounce"
                    ? { x: (a.x + b.x) / 2 + geom.cardW / 2 + 40, y: (a.y + a.h + b.y) / 2 + 2, text: "打回" }
                    : null,
        });
    }

    return {
        width: Math.max(lanes.length * geom.laneW, geom.laneW),
        height: geom.topPad + Math.max(visits.length, 1) * step - geom.rowGap + 16,
        lanes: stageLanes,
        visits,
        wires,
    };
}
