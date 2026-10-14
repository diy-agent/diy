// container.ts — 泳道容器：位置 = 单指针
//
// 依据 ##166 §10.2 / §11.1 / §12.3、##311 §一：
//   泳道容器与消息容器的差别只在**容器不变量** —— 泳道容器是「**单指针 · 有序 · 可回退**」，
//   恒有且只有一个「当前节点」；写入语义是**位置变更**（不是追加），历史形状是**一条折线**。
//
// 记录本身复用 @diy/talk 的 `Event` 原语（`anchor = node` 指目标节点）——「不是像，是同一个东西的两组规则」。
// 一条转移 = 一条 Event；**打回 = 走一条 `bounce` 边 = 目标节点再驻留一次**（`visit.seq` 递增），
// **不新建节点**（##166 §14.2 推论 2）。边的 `kind` 只记进 `Visit`，不改结构。
//
// 本包只做「定义 + 位置」，**不做 guard 求值**（归 ##315）、**不做参数校验**（归 ##316）。

import type { Event } from '@diy/talk';
import type { EdgeKind, WorkflowDef } from './define';
import { FlowError } from './errors';

/** 一次驻留：折线在某个节点上停留的一次（同一节点可驻留多次 —— 打回后再穿过） */
export interface Visit<Id extends string = string> {
    readonly node: Id;
    /** 该节点第几次驻留（1-based）；`>=2` 即「打回后重返」 */
    readonly seq: number;
    /** 进入本次驻留所走的边；首次进入（入口）记为 `'next'` */
    readonly kind: EdgeKind;
    /** 触发本次位置变更的事件 id */
    readonly eventId: string;
    /** 该事件的发生时刻（ISO-8601，由调用方传入 —— 本包不取时间） */
    readonly at: string;
}

/** 容器态：恒有且只有一个 `position`（`null` = 尚未进入工作流），加一条折线 `path` */
export interface FlowState<Id extends string = string> {
    readonly position: Id | null;
    readonly path: readonly Visit<Id>[];
}

/** 初始态：位置空、折线空 */
export function initialState<Id extends string>(): FlowState<Id> {
    return { position: null, path: [] };
}

function seqOf<Id extends string>(path: readonly Visit<Id>[], node: Id): number {
    let n = 0;
    for (const v of path) if (v.node === node) n += 1;
    return n;
}

/**
 * 应用一条事件，返回**新的**容器态（纯函数，不改入参）。
 *
 * 位置变更规则：
 * - 位置为空（未进入）→ 事件必须进入**入口节点**，否则 `invalid-entry`；
 * - 有位置 → 必须存在一条 `position → to` 的边，否则 `no-edge`（不允许跳步）；边 `kind` 记入 `Visit`。
 *
 * 事件锚点必须是 `node`（`anchor.data.nodeId` = 目标节点），否则 `invalid-event`；
 * 目标节点必须存在于定义中，否则 `unknown-node`。
 */
export function apply<Id extends string>(def: WorkflowDef<Id>, state: FlowState<Id>, event: Event): FlowState<Id> {
    if (event.anchor.type !== 'node') {
        throw new FlowError('invalid-event', '工作流事件的锚点必须是 node（位置变更靠 anchor.data.nodeId 指目标节点）', 'event.anchor.type');
    }
    const to = event.anchor.data.nodeId as Id;
    if (!def.nodes.some((n) => n.id === to)) {
        throw new FlowError('unknown-node', `事件指向未知节点 ${JSON.stringify(to)}`, 'event.anchor.data.nodeId');
    }

    let kind: EdgeKind;
    if (state.position === null) {
        if (to !== def.entry) {
            throw new FlowError('invalid-entry', `首个事件必须进入入口节点 ${JSON.stringify(def.entry)}，实得 ${JSON.stringify(to)}`, 'event.anchor.data.nodeId');
        }
        kind = 'next';
    } else {
        const edge = def.edges.find((e) => e.from === state.position && e.to === to);
        if (!edge) {
            throw new FlowError('no-edge', `不存在从 ${JSON.stringify(state.position)} 到 ${JSON.stringify(to)} 的边`, 'event.anchor.data.nodeId');
        }
        kind = edge.kind;
    }

    const visit: Visit<Id> = {
        node: to,
        seq: seqOf(state.path, to) + 1,
        kind,
        eventId: event.id,
        at: event.at,
    };
    return { position: to, path: [...state.path, visit] };
}

/**
 * 单指针容器：`apply(event) → 新容器`（不可变 —— 每次返回新对象，旧容器不受影响）。
 *
 * ```ts
 * const c0 = createContainer(wf);
 * const c1 = c0.apply(clarifyEvent);   // 位置 = 'clarify'
 * const c2 = c1.apply(designEvent);    // 位置 = 'design'
 * ```
 */
export interface Container<Id extends string = string> {
    readonly def: WorkflowDef<Id>;
    /** 当前节点（`null` = 尚未进入） */
    readonly position: Id | null;
    /** 折线轨迹（只读） */
    readonly path: readonly Visit<Id>[];
    apply(event: Event): Container<Id>;
}

export function createContainer<Id extends string>(def: WorkflowDef<Id>): Container<Id> {
    const build = (state: FlowState<Id>): Container<Id> => ({
        def,
        get position() {
            return state.position;
        },
        get path() {
            return state.path;
        },
        apply: (event: Event) => build(apply(def, state, event)),
    });
    return build(initialState<Id>());
}
