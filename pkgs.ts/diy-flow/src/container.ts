// container.ts — 泳道容器：位置 = 单指针（##333：领域状态一等，事件降为审计）
//
// 依据 ##166 §10.2 / §11.1 / §12.3、##311 §一、##333（依赖反转）：
//   泳道容器与消息容器的差别只在**容器不变量** —— 泳道容器是「**单指针 · 有序 · 可回退**」，
//   恒有且只有一个「当前节点」；写入语义是**位置变更**（不是追加），历史形状是**一条折线**。
//
// ── ##333 依赖反转：领域状态一等，`Event` 退出 core 概念层 ──────────────────────────
//   ① **领域态 `FlowState{ position, path }` 自成真源**：它的每一步由**领域操作** `advance` 产出 ——
//      只吃领域输入 `{ to, at, ref? }`（目标节点 / 时刻 / 宿主关联），**不吃日志**。
//      于是它可独立序列化落盘、可读回（`serialize.ts`），清掉日志也不影响运行。
//   ② `Visit` 只记**领域事实**：`node` / `seq` / `kind` / `at`（四项）+ 宿主关联 `ref`。
//      旧版必填的 `eventId` **已删** —— 领域不必知道日志。
//   ③ **方向反转**：关联由**审计侧指回领域**（审计记录带领域坐标 `{ node, seq }`，即
//      `state.path.at(-1)` 那条 Visit），而不是领域记录携带日志 id。
//   ④ `apply(def, state, event)` **保留为薄适配**（见文件末尾「审计 / 消息入口」一节）——
//      它只把一条消息翻译成一次 `advance`，**不参与状态构造**，也不再是状态的唯一来源。
//
//   一条转移仍可写成一条 `Event`（`anchor = node` 指目标节点）——「不是像，是同一个东西的两组规则」
//   依旧成立；但那条 Event 现在是**消息**（进度通知 / 审计材料），不是状态载体。
//   **打回 = 走一条 `bounce` 边 = 目标节点再驻留一次**（`visit.seq` 递增），**不新建节点**（##166 §14.2 推论 2）。
//
// 本文件只做「位置」：**不做 guard 求值**（在 `eval.ts` + `execute.ts`）、**不做参数校验**（归 ##316）、
// **不碰存储**（落盘位置 / 文件布局归 ##319）。

import type { Event } from '@diy/talk';
import type { EdgeKind, WorkflowDef } from './define';
import { FlowError, type FlowErrorCode } from './errors';
import { isIsoString, isObject, rejectUnknown } from './validate';

/**
 * 一次驻留：折线在某个节点上停留的一次（同一节点可驻留多次 —— 打回后再穿过）。
 *
 * 四项全是**领域事实**（##333）：`node` 停在哪、`seq` 第几次、`kind` 怎么进来的、`at` 什么时候。
 * 日志 id **不在其中**（旧 `eventId` 已删）—— 领域不必知道日志。
 */
export interface Visit<Id extends string = string> {
    readonly node: Id;
    /** 该节点第几次驻留（1-based）；`>=2` 即「打回后重返」 */
    readonly seq: number;
    /** 进入本次驻留所走的边；首次进入（入口）记为 `'next'` */
    readonly kind: EdgeKind;
    /** 本次驻留的时刻（ISO-8601，由调用方传入 —— 本包不取时间） */
    readonly at: string;
    /**
     * 宿主关联标识（`taskUri` / `turnId` / `stepId`…）—— **开放袋，内核只透传不解释**（##333 交付 E）。
     *
     * 与 `@diy/talk` 的 `Anchor` / `DocRangeAnchorData.revisionId` 同一用意：横向模块之间靠**显式 ref**
     * 对齐，不靠共享日志（##310 的 `ctxlog.ref` 同形）。键不封闭（宿主自己命名），值必须是字符串。
     */
    readonly ref?: Readonly<Record<string, string>>;
}

/**
 * 容器态：恒有且只有一个 `position`（`null` = 尚未进入工作流），加一条折线 `path`。
 *
 * **这是领域真源**（##333）：可整份序列化落盘（`flowStateToJson`）、可读回（`parseFlowState`）。
 * `path` 本身 append-only（`advance` 只追加一条 Visit），故「增量 + 可重建快照」两种形态都满足。
 */
export interface FlowState<Id extends string = string> {
    readonly position: Id | null;
    readonly path: readonly Visit<Id>[];
    /**
     * **L2 实例参数值**（##316 声明 + 校验，##333 交付 G）：`{ 节点 id: { 局部名: 值 } }`，
     * 全量（缺省已合并）、纯 JSON、冻结。
     *
     * 为什么它在**领域态**里：##311 §二 L3 把「领域状态」定义为 `path` / `position` / **params 值** ——
     * 参数值不是日志、也不是运行期临时物，它是**这次运行的领域事实**。不放进状态，「状态文件为一等真源」
     * 就断了：读回后只能跑在**另一份**参数值上（读不回原样）。
     *
     * 值语义（类型 / enum / 上下界 / 纯 JSON）归 ##316：`resolveParams(paramsOf(def), 宿主值)` 是唯一入口，
     * 本文件**不重写校验**；这里只保证它随状态一起流转、可落盘、可读回。
     * 缺省（`undefined`）= 没有参数值（工作流没声明参数、宿主也没给袋）。
     */
    readonly params?: Readonly<Record<string, unknown>>;
    /**
     * **终态标记**：guard 全过、且当前位置**压根没有 `next` 出边** ⇒ 工作流跑完了（##333 交付 F）。
     *
     * 为什么记在领域态里：`step` 每次调用都会重新求值 guard（`action:` 可能写外部世界），
     * 而「已经跑完」是**领域事实**、不是日志事实 —— 记下来，重复 `step` 才能不重跑 `action:`
     * （##315 review2 §D 的记账）。缺省（`undefined`）= 仍在跑。
     */
    readonly done?: boolean;
}

/** 初始态：位置空、折线空 */
export function initialState<Id extends string>(): FlowState<Id> {
    return { position: null, path: [] };
}

/** 领域推进的输入：**只含领域事实**（内核不取时间、不生成 id、不碰日志） */
export interface AdvanceRequest<Id extends string = string> {
    /** 目标节点（入口首次进入时必须是 `def.entry`） */
    readonly to: Id;
    /** 这次驻留的时刻（ISO-8601）—— 时间是事实，由调用方给 */
    readonly at: string;
    /** 宿主关联标识（见 `Visit.ref`） */
    readonly ref?: Readonly<Record<string, string>>;
}

/** `advance` 的产物：新态 + 本次驻留所走的边种类 */
export interface Advance<Id extends string = string> {
    readonly state: FlowState<Id>;
    /** 本次驻留的边种类（入口首次进入记为 `'next'`） */
    readonly kind: EdgeKind;
}

const ADVANCE_KEYS = ['to', 'at', 'ref'] as const;

/**
 * 解析宿主的关联袋（`Visit.ref`）：**开放键**（宿主自己命名，内核不解释）、**值必须是字符串**。
 *
 * 开放的是键、不是形状 —— 值类型错了照样大声报（否则「关联」会静默变成 `[object Object]`）。
 */
export function parseRef(value: unknown, path: string, code: FlowErrorCode = 'invalid-option'): Readonly<Record<string, string>> | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isObject(value)) throw new FlowError(code, 'ref 应为「字符串 → 字符串」的对象', path);
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') throw new FlowError(code, `ref 的值应为字符串（${JSON.stringify(key)} 实得 ${typeof item}）`, `${path}.${key}`);
        out[key] = item;
    }
    return Object.freeze(out);
}

function seqOf<Id extends string>(path: readonly Visit<Id>[], node: Id): number {
    let n = 0;
    for (const v of path) if (v.node === node) n += 1;
    return n;
}

/**
 * **领域操作**：把一次位置变更应用到领域态上，返回**新的**容器态（纯函数，不改入参）。
 *
 * 位置变更规则：
 * - 位置为空（未进入）→ 必须进入**入口节点**，否则 `invalid-entry`；
 * - 有位置 → 必须存在一条 `position → to` 的边，否则 `no-edge`（不允许跳步）；边 `kind` 记入 `Visit`。
 *
 * 目标节点必须存在于定义中，否则 `unknown-node`。`at` 必须是 ISO-8601（领域态要落盘，
 * 时间必须先是**事实**才能是**数据**）。
 *
 * 注意它**不吃事件**：领域推进与「有没有日志」无关（##333）。
 *
 * `toPath` 是**目标字段的点路径**（缺省 `request.to`）—— 同一个错误，谁调的就说谁的话：
 * `apply` 传 `event.anchor.data.nodeId`，好让「从日志重建」那条路上的报错仍指向事件侧的字段
 * （其余诊断以它的父路径为前缀）。
 */
export function advance<Id extends string>(def: WorkflowDef<Id>, state: FlowState<Id>, request: AdvanceRequest<Id>, toPath = 'request.to'): Advance<Id> {
    const base = toPath.includes('.') ? toPath.slice(0, toPath.lastIndexOf('.')) : toPath;
    if (!isObject(request)) throw new FlowError('invalid-option', 'advance 的请求应为对象（{ to, at, ref? }）', base);
    rejectUnknown(request as unknown as Record<string, unknown>, ADVANCE_KEYS, base, 'invalid-option');
    const to = request.to;
    if (typeof to !== 'string' || to === '') throw new FlowError('invalid-option', 'to 必填（目标节点 id）', toPath);
    if (!isIsoString(request.at)) {
        throw new FlowError('invalid-option', `at 应为 ISO-8601 时刻（如 2026-10-13T00:00:00.000Z），实得 ${JSON.stringify(request.at)}`, `${base}.at`);
    }
    const ref = parseRef(request.ref, `${base}.ref`);

    if (!def.nodes.some((n) => n.id === to)) {
        throw new FlowError('unknown-node', `事件指向未知节点 ${JSON.stringify(to)}`, toPath);
    }

    let kind: EdgeKind;
    if (state.position === null) {
        if (to !== def.entry) {
            throw new FlowError('invalid-entry', `首个事件必须进入入口节点 ${JSON.stringify(def.entry)}，实得 ${JSON.stringify(to)}`, toPath);
        }
        kind = 'next';
    } else {
        const edge = def.edges.find((e) => e.from === state.position && e.to === to);
        if (!edge) {
            throw new FlowError('no-edge', `不存在从 ${JSON.stringify(state.position)} 到 ${JSON.stringify(to)} 的边`, toPath);
        }
        kind = edge.kind;
    }

    const visit: Visit<Id> = ref === undefined
        ? { node: to as Id, seq: seqOf(state.path, to as Id) + 1, kind, at: request.at }
        : { node: to as Id, seq: seqOf(state.path, to as Id) + 1, kind, at: request.at, ref };
    // 推进即离开终态：`done` 不继承（能走，就说明没走完）；`params` 是这次运行的配置 ⇒ **继承**
    // （换参数值不是一次「位置变更」，那是另起一次运行 —— 归宿主决定，见 ##319）
    const next: { position: Id; path: readonly Visit<Id>[]; params?: Readonly<Record<string, unknown>> } = {
        position: to as Id,
        path: [...state.path, visit],
    };
    if (state.params !== undefined) next.params = state.params;
    return { state: next, kind };
}

/**
 * 单指针容器：领域推进 `advance(request)` + 审计适配 `apply(event)`（不可变 —— 每次返回新对象）。
 *
 * ```ts
 * const c0 = createContainer(wf);
 * const c1 = c0.advance({ to: 'design', at });     // 正路：领域输入，无日志
 * const c2 = c1.apply(designEvent);                // 兼容路：一条消息 → 一次领域推进
 * ```
 */
export interface Container<Id extends string = string> {
    readonly def: WorkflowDef<Id>;
    /** 当前节点（`null` = 尚未进入） */
    readonly position: Id | null;
    /** 折线轨迹（只读） */
    readonly path: readonly Visit<Id>[];
    /** 是否已跑完（见 `FlowState.done`） */
    readonly done: boolean;
    /** **领域推进**（正路）：只吃领域输入，不产生也不依赖任何日志 */
    advance(request: AdvanceRequest<Id>): Container<Id>;
    /** **审计 / 消息入口**（薄适配，见 `apply`）：一条 Event → 一次领域推进 */
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
        get done() {
            return state.done === true;
        },
        advance: (request: AdvanceRequest<Id>) => build(advance(def, state, request).state),
        apply: (event: Event) => build(apply(def, state, event)),
    });
    return build(initialState<Id>());
}

// ── 审计 / 消息入口（**不参与状态构造**）──────────────────────────────────────────
// `apply` 只是把一条**消息**（`@diy/talk` 的 `Event`，`anchor.data.nodeId` = 目标节点）翻译成一次
// 领域操作 —— ##333 之后它**不再是状态的来源**，领域态的正路是 `advance`。留它有两个用处：
//   ① 从旧日志 / 审计流**重建**领域态（`project.ts` 的重放路径）；
//   ② 兼容「一条转移 = 一条 Event」的老调用方（##312~##315 的既有语义不变）。
// **事件的 id / author / content 一律不进领域态** —— 领域只记 `{ node, seq, kind, at, ref }`。
// 反过来，审计侧要指回领域，用 `state.path.at(-1)` 的 `{ node, seq }` 作坐标（方向反转，交付 B）。

/**
 * 薄适配：`Event`（`anchor.data.nodeId` = 目标节点）→ `advance`。
 *
 * 错误码与旧版逐条对齐：锚点不是 `node` → `invalid-event`；未知节点 → `unknown-node`；
 * 未进入却没进入口 → `invalid-entry`；没有对应边 → `no-edge`。
 */
export function apply<Id extends string>(def: WorkflowDef<Id>, state: FlowState<Id>, event: Event): FlowState<Id> {
    if (event.anchor.type !== 'node') {
        throw new FlowError('invalid-event', '工作流事件的锚点必须是 node（位置变更靠 anchor.data.nodeId 指目标节点）', 'event.anchor.type');
    }
    return advance(def, state, { to: event.anchor.data.nodeId as Id, at: event.at }, 'event.anchor.data.nodeId').state;
}
