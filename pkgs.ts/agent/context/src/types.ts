// src/shared/context/types.ts
// 🎯 Context Tree 的**领域类型**（纯类型 + 少量常量，零运行时依赖）。
//
// 设计来源：任务 144「system context 注入机制（第二版）」的收敛结论；##520 把
// 「system / runtime 两个投递容器」整段删掉 —— 信封里只有**一棵变量树、一段全量**，
// 变化走 user 增量。所以这里不再有容器（container / placement）概念。
//
// 三层不可混淆（144 的核心结论）：
//   ContextFact   事实       —— 事件的领域投影（snapshot/replace/patch/remove）
//   ContextTree   唯一状态   —— 值树 + 渲染声明 + places + wireVersion
//   projection    模型 wire  —— 信封全文 + 单元级增量
//
// 两个 hash 分离（144 结论，别混用）：
//   valueHash     —— 值树里的**原始值**（patch 后变了就是变了）
//   renderedHash  —— 该 place **渲染出来**的文本（模板没引用到的值变了，它不变）
// 事实本身只描述「什么变了」；hash 是**派生**量，由树算出（事实里的同名字段只作审计/一致性校验）。
//
// 约定：本文件（及同目录）只放纯函数，禁止 import node:*（renderer 会打进包）。

/**
 * 稳定路径：点分段，沿用旧变量风格（`diy.cli` / `task.uri`）。
 * 段字符集见 path.ts；108 之前不引入新的路径编码方案。
 */
export type ContextPath = string;

/**
 * 渲染方式声明（挂在 path 上；**值本身在值树里**，两者分开才让「值变而渲染不变」可判）。
 * 缺省 yaml —— 未声明的路径按结构化值 dump。
 */
export type ContextRendererSpec =
    | { renderer: "yaml" }
    | { renderer: "text" }
    /** 模板节点：source 是 @diy-agent/template 源码，渲染作用域 = 整棵值树 */
    | { renderer: "template"; source: string };

// ─── 事实（ContextFact）─────────────────────────────────

/** 全量快照：替换整棵树状态（唯一版本兼容点，投影时声明 supersedes=all） */
export interface ContextSnapshotFact {
    type: "snapshot";
    /** 快照作用域（审计用；树是唯一状态，第一版按整树恢复） */
    scope: string;
    state: ContextTreeState;
}

/**
 * 整体替换一个 path 处的**节点**（内容 + 渲染方式）。
 * 与 patch 的分工：replace 换整节点（含渲染方式），patch 改值树里的字段。
 */
export interface ContextReplaceFact {
    type: "replace";
    path: ContextPath;
    /** contentFormat=yaml 时是 YAML 文本；=template-text 时是模板源码 */
    content: string;
    contentFormat: "yaml" | "template-text";
    /** 发送方声明的值 hash（可选）：提供则与实际结果比对，不符即拒绝（adapter 转错的探针） */
    valueHash?: string;
    /** 发送方声明的渲染 hash（可选）：同上 */
    renderedHash?: string;
    /** 期望的旧值 hash（可选）：不匹配则拒绝静默合并 */
    baseHash?: string;
}

/** 路径级增量修改：按稳定路径改值树里的一个字段（place 边界与 patch 边界是两回事） */
export interface ContextPatchFact {
    type: "patch";
    path: ContextPath;
    op: "set" | "replace" | "remove";
    value?: unknown;
    /** 期望的旧值 hash（可选）：不匹配则拒绝静默合并 */
    baseHash?: string;
}

/** 删除一个 path（连同其整棵子树，以及子树上的渲染声明） */
export interface ContextRemoveFact {
    type: "remove";
    path: ContextPath;
}

export type ContextFact =
    | ContextSnapshotFact
    | ContextReplaceFact
    | ContextPatchFact
    | ContextRemoveFact;

// ─── 状态（ContextTree）─────────────────────────────────

/** 树的唯一状态：108 之后仍应是这个形状（只换喂进来的事实来源） */
export interface ContextTreeState {
    /** 值树：嵌套 JSON（顶层是对象）。patch/replace 都落在这里 */
    values: Record<string, unknown>;
    /** 渲染方式声明：path → spec（缺省 yaml） */
    renderers: Record<ContextPath, ContextRendererSpec>;
    /** 割点集合（**原子单元**的边界）：两两不可互为祖先/后代；决定增量与变更历史的粒度 */
    places: ContextPath[];
    /** 模型 wire 编码版本（由 WIRE_ENCODING 派生，见 wire.ts） */
    wireVersion: string;
}

/** 事实被拒绝的原因（一律不静默合并） */
export type ContextRejectReason =
    | "invalid-path"
    | "base-hash-mismatch"
    | "hash-mismatch"
    | "not-found"
    | "bad-content";

/** applyFact 的结果（纯函数：返回新状态，不改入参） */
export interface ContextApplyResult {
    state: ContextTreeState;
    /** 有值 = 该事实未生效（树保持原样） */
    rejected?: ContextRejectReason;
    /** 是否要求重发全量（快照恢复 / 拒绝合并 / 版本变化） */
    needRebaseline: boolean;
}

// ─── 投影（模型 wire）─────────────────────────────────

/** 单元级增量动作 */
export type DeltaOp =
    | { op: "set"; path: ContextPath; content: string }
    | { op: "remove"; path: ContextPath };

/**
 * 自上次投递以来的增量。
 *   none     —— 内容未变，不发（144 用例 4）
 *   patch    —— 增量（用例 3）
 *   snapshot —— 全量 baseline，声明 supersedes=all（版本变化 / 恢复）
 *   clear    —— 单元全部消失，必须**显式**清空（用例 5），不能只是「什么都不发」
 */
export type DeltaDelivery =
    | { kind: "none" }
    | { kind: "patch"; ops: DeltaOp[] }
    | { kind: "snapshot"; text: string; supersedes: "all" }
    | { kind: "clear" };

/** 上一次投递的水位（增量判据；第一版放内存，108 后由事件回放重建） */
export interface DeliveryCursor {
    /** place → 上次投递的 renderedHash */
    delivered: Record<ContextPath, string>;
    wireVersion: string;
}

/** 一次投影的产物 */
export interface ContextProjection {
    /** 信封全文（`help:` + `vars:`；每次请求全量重建，故天然无 patch） */
    text: string;
    /** 纯数据段（不带 help；golden 比对 / 调试用） */
    data: string;
    /** 自上次以来的单元级增量（无变化 = `kind: "none"`） */
    delta: DeltaDelivery;
    /** 本次是否要求重发全量 */
    needRebaseline: boolean;
}

export interface ProjectionResult {
    projection: ContextProjection;
    /** 下一次的水位 */
    cursor: DeliveryCursor;
}

// ─── step 统计 ─────────────────────────────────────────

/** step 内变化统计的结果（144 用例 11~13） */
export interface ContextStepDelta {
    /** step 前后**最终** hash 不同的 path（字典序，稳定可比对） */
    changed: ContextPath[];
    /** 每个变化 path 记 1 次（改多次、改回原值都不重复计） */
    counts: Record<ContextPath, number>;
}
