// compile.ts —— 模板 → dockview 布局；用户布局 × 新模板 → 新布局。
//
// 只有一个真源：**dockview 的布局快照**（`api.toJSON()`）。模板不是第二份布局，
// 它只是编译器的输入。所以这里的两个纯函数是全部复杂度：
//
//   compileLayout  模板 + view 注册表 → 一份干净的布局（第一次进这个页，或 resetLayout）
//   resolveLayout  上一份布局 × 新模板 → 新布局（模板改了 view 增删了，用户的拖拽结果要保住）
//
// 两者都不碰 DOM、不碰 React、不碰全局状态 —— 单测就测这两个。

import type { GroupviewPanelState, SerializedDockview, SerializedGridObject } from 'dockview';

import {
    ModelError,
    areaLeaves,
    pageId,
    pageTitle,
    placementOf,
    viewTitle,
    type AreaNode,
    type Axis,
    type PageDef,
    type Scope,
    type Size,
    type ViewDef,
} from './model.js';

/** dockview 的叶子数据：一个区域 = 一个 group */
export interface AreaGroupState {
    id: string;
    views: string[];
    activeView?: string;
    hideHeader?: boolean;
    constraints?: { minimumWidth?: number; minimumHeight?: number };
}

/** dockview 的 serialized grid 节点（branch 无 id；叶子靠 `data.id` 认出区域） */
export interface AreaLeafNode extends SerializedGridObject<AreaGroupState> {
    type: 'leaf';
    data: AreaGroupState;
    size: number;
}
export interface AreaBranchNode extends SerializedGridObject<AreaGroupState> {
    type: 'branch';
    data: DockNode[];
    size: number;
}
export type DockNode = AreaLeafNode | AreaBranchNode;

/** 布局的 grid 部分（`SerializedDockview['grid']` 的窄化版） */
export interface DockGrid {
    root: DockNode;
    width: number;
    height: number;
    orientation: 'HORIZONTAL' | 'VERTICAL';
}

export interface Viewport {
    width: number;
    height: number;
}

export interface CompiledArea {
    id: string;
    visible: boolean;
    views: string[];
    activeView?: string;
}

export interface CompiledLayout {
    pageType: string;
    /** 页实例 id：`task-run@task:t-1` */
    pageId: string;
    title: string;
    icon?: string;
    grid: DockGrid;
    panels: Record<string, GroupviewPanelState>;
    activeGroup?: string;
    /** 布局里真实存在的区域（= 至少有一个 view 落位） */
    areas: Record<string, CompiledArea>;
    /** 模板里有、但因为没有任何 view 落位而被跳过的区域 */
    skippedAreas: string[];
}

export interface LayoutInput<S extends Scope = Scope> {
    page: PageDef<S>;
    views: readonly ViewDef<S>[];
    scope: S;
    viewport: Viewport;
}

/** 用户布局的持久化形态。除了 dockview 快照，只需要多记两样东西 */
export interface SavedLayout {
    version: 1;
    pageType: string;
    scopeKey: string;
    /** dockview `api.toJSON()` 原样存 —— 不解析、不改写 */
    dock: SerializedDockview;
    /** 用户显式关掉的 view：模板重编译时不再自动加回来（缺了这份记账就分不清"关的"和"新加的"） */
    dismissed: string[];
    /** dockview 的快照不含最大化状态，单独记 */
    maximizedArea?: string;
}

/** panel 内容组件名（所有 view 共用一个 React 外壳，靠 params.viewId 分发） */
export const VIEW_COMPONENT = 'view';

// ── 1. 模板 → 布局 ──────────────────────────────────────────────────────────

export function compileLayout<S extends Scope>(input: LayoutInput<S>): CompiledLayout {
    const { page, views, scope, viewport } = input;
    const slots = collectSlots(page, views, scope);

    const skippedAreas: string[] = [];
    const root = compileNode(page.areas, slots, depthAxis(page.areas), viewport, skippedAreas);
    if (!root) throw new ModelError(`page "${page.type}" 没有任何区域有 view 落位`);

    const panels: Record<string, GroupviewPanelState> = {};
    for (const slot of slots.values()) {
        for (const view of slot.views) {
            panels[view.id] = {
                id: view.id,
                contentComponent: VIEW_COMPONENT,
                title: viewTitle(view, scope),
                params: { viewId: view.id, areaId: slot.areaId },
            };
        }
    }

    const areas = areasOf(root);
    return {
        pageType: page.type,
        pageId: pageId(page.type, scope),
        title: pageTitle(page, scope),
        icon: page.icon,
        grid: {
            root,
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
            orientation: depthAxis(page.areas) === 'x' ? 'HORIZONTAL' : 'VERTICAL',
        },
        panels,
        activeGroup: primaryArea(page, slots) ?? Object.keys(areas)[0],
        // 注：sizes 已经是 px（compileNode 里落的），这里不再二次换算
        areas,
        skippedAreas,
    };
}

interface AreaSlot<S extends Scope = Scope> {
    areaId: string;
    views: ViewDef<S>[];
    activeView?: string;
}

/** 按区域归拢 view：过滤 → 按 order 排序 → 定 activeView（primary 优先） */
function collectSlots<S extends Scope>(
    page: PageDef<S>,
    views: readonly ViewDef<S>[],
    scope: S,
): Map<string, AreaSlot<S>> {
    const known = new Set(areaLeaves(page.areas).map((leaf) => leaf.id));
    const slots = new Map<string, AreaSlot<S>>();
    for (const view of views) {
        const placement = placementOf(view, page.type);
        if (!placement) continue; // 这个 view 不属于这个页
        if (!known.has(placement.area)) {
            throw new ModelError(
                `view "${view.id}" 的 placement 指向 page "${page.type}" 里不存在的区域 "${placement.area}"`,
            );
        }
        const slot = slots.get(placement.area) ?? { areaId: placement.area, views: [] };
        slot.views.push(view);
        if (placement.primary) {
            if (slot.activeView)
                throw new ModelError(`page "${page.type}" 的区域 "${placement.area}" 有多个 primary view`);
            slot.activeView = view.id;
        }
        slots.set(placement.area, slot);
    }
    for (const slot of slots.values()) {
        slot.views.sort((a, b) => order(a, page.type) - order(b, page.type));
        slot.activeView ??= slot.views[0]?.id;
    }
    void scope;
    return slots;
}

function order<S extends Scope>(view: ViewDef<S>, pageType: string): number {
    return placementOf(view, pageType)?.order ?? 1000;
}

/** 有 primary view 的区域优先激活 */
function primaryArea<S extends Scope>(page: PageDef<S>, slots: Map<string, AreaSlot<S>>): string | undefined {
    for (const slot of slots.values()) {
        if (slot.views.some((view) => placementOf(view, page.type)?.primary)) return slot.areaId;
    }
    return undefined;
}

/** 区域树的根轴：单区域页包一层 y（dockview 的 grid 以 branch 为根最稳） */
function depthAxis(node: AreaNode): Axis {
    return node.type === 'split' ? node.data.axis : 'y';
}

/**
 * 模板树 → dockview 树。尺寸在这一步落成 px：
 * 数字原样，`fr` 在同父兄弟间分**剩余**空间（与 dockview 对 size 的语义一致）。
 */
function compileNode<S extends Scope>(
    node: AreaNode,
    slots: Map<string, AreaSlot<S>>,
    axis: Axis,
    viewport: Viewport,
    skipped: string[],
): DockNode | null {
    // `axis` = 本节点被拉长的方向（= 父分割的轴）；`node.data.axis` = 本节点切自己子区域的方向。
    // 两者不同：col 里的 row 子节点沿 y 拿高度，它自己的子节点沿 x 分宽度。
    const own = axis === 'x' ? viewport.width : viewport.height;
    const inner = node.type === 'split' && node.data.axis === 'x' ? viewport.width : viewport.height;

    if (node.type === 'region') {
        const slot = slots.get(node.id);
        if (!slot) {
            skipped.push(node.id);
            return null;
        }
        return {
            type: 'leaf',
            size: px(node.size, own),
            visible: node.data.initial !== 'collapsed',
            data: {
                id: node.id,
                views: slot.views.map((view) => view.id),
                activeView: slot.activeView,
                hideHeader: node.data.hideHeader,
                constraints: node.min === undefined ? undefined : { minimumWidth: node.min, minimumHeight: node.min },
            },
        };
    }

    const sizes = distribute(
        node.data.children.map((child) => child.size),
        inner,
    );
    const children: DockNode[] = [];
    node.data.children.forEach((child, index) => {
        const compiled = compileNode(child, slots, node.data.axis, viewport, skipped);
        if (compiled) {
            compiled.size = sizes[index];
            children.push(compiled);
        }
    });
    if (children.length === 0) return null;
    return { type: 'branch', data: children, size: px(node.size, own) };
}

/** 一组兄弟的尺寸：数字是 px，`fr` 分剩余空间 */
function distribute(sizes: Size[], available: number): number[] {
    let fixed = 0;
    let totalFr = 0;
    for (const size of sizes) {
        fixed += asPx(size) ?? 0;
        totalFr += frOf(size);
    }
    const rest = Math.max(0, available - fixed);
    return sizes.map((size) => {
        const value = asPx(size) ?? (totalFr > 0 ? (rest * frOf(size)) / totalFr : 0);
        return Math.max(0, Math.round(value));
    });
}

// 注：写成 if-return 形式 —— TS 7（tsgo）在 reduce/map 回调里对模板字面量联合类型
// 不收敛 `typeof x === 'number'`，三元里会报「+ 不能应用于 string | number」
function asPx(size: Size): number | undefined {
    if (typeof size === 'number') return size;
    return undefined;
}

function frOf(size: Size): number {
    if (typeof size === 'number') return 0;
    return Number.parseFloat(size);
}

function px(size: Size, available: number): number {
    return Math.max(0, Math.round(asPx(size) ?? available));
}

// ── 2. 旧布局 × 新模板 ──────────────────────────────────────────────────────

export interface ResolveInput<S extends Scope = Scope> extends LayoutInput<S> {
    saved?: SavedLayout | null;
}

/**
 * 规则（R1–R4）：
 *   R1 旧布局里有这个区域  → 保留尺寸、展开状态、tab 顺序、activeView
 *   R2 新模板有、旧布局没有 → 用模板的尺寸与 initial
 *   R3 旧布局有、新模板没有 → 丢弃（模板删了该区域）
 *   R4 view：旧布局 − 已关掉的     → 保留
 *          view：模板有、旧布局没有 → 按 order 插进它声明的区域
 *          view：旧布局有、注册表没有 → 丢弃（代码里删了）
 */
export function resolveLayout<S extends Scope>(input: ResolveInput<S>): CompiledLayout {
    const compiled = compileLayout(input);
    const saved = input.saved;
    if (!saved || saved.pageType !== compiled.pageType) return compiled;

    const dismissed = new Set(saved.dismissed);
    const prev = new Map<string, PrevLeaf>();
    // saved 是我们自己写进去的快照，结构一定是 DockNode（dockview 的类型更宽）
    for (const leaf of leavesOf(saved.dock.grid.root as DockNode)) {
        if (leaf.data.id) prev.set(leaf.data.id, leaf);
    }

    const merged = mergeNode(compiled.grid.root, prev, dismissed);
    if (!merged) return compiled; // 全都关掉了 → 回到模板（不留一个空壳）

    const panels: Record<string, GroupviewPanelState> = {};
    for (const leaf of leavesOf(merged)) {
        for (const panelId of leaf.data.views) {
            const template = compiled.panels[panelId];
            if (template) panels[panelId] = { ...template, params: { ...template.params, areaId: leaf.data.id } };
        }
    }

    const areas = areasOf(merged);
    const activeGroup =
        saved.dock.activeGroup && areas[saved.dock.activeGroup] ? saved.dock.activeGroup : compiled.activeGroup;

    return { ...compiled, grid: { ...compiled.grid, root: merged }, panels, activeGroup, areas };
}

/** 旧布局的叶子（形状同 AreaLeafNode；分开命名只为读起来清楚） */
type PrevLeaf = AreaLeafNode;

function mergeNode(node: DockNode, prev: Map<string, PrevLeaf>, dismissed: Set<string>): DockNode | null {
    if (node.type === 'leaf') {
        const id = node.data.id;
        const before = prev.get(id);
        // 模板里剩下的 view = 注册表里还有的（模板是编译出来的）− 用户关掉的
        const templateViews = node.data.views.filter((viewId) => !dismissed.has(viewId));
        // 顺序：旧布局的 tab 顺序优先，新加的接在后面
        const kept = (before?.data.views ?? []).filter((viewId) => templateViews.includes(viewId));
        const views = [...kept, ...templateViews.filter((viewId) => !kept.includes(viewId))];
        if (views.length === 0) return null;
        const activeView =
            before?.data.activeView && views.includes(before.data.activeView) ? before.data.activeView : views[0];
        return {
            ...node,
            size: before?.size ?? node.size,
            visible: before ? (before.visible ?? true) : node.visible,
            data: { ...node.data, views, activeView },
        };
    }

    const children = node.data
        .map((child) => mergeNode(child, prev, dismissed))
        .filter((child): child is DockNode => child !== null);
    if (children.length === 0) return null;
    return { ...node, data: children };
}

// ── 3. 读布局 ──────────────────────────────────────────────────────────────

/** 布局树的全部叶子（区域），先序 */
export function leavesOf(node: DockNode): AreaLeafNode[] {
    if (node.type === 'leaf') return [node];
    return node.data.flatMap(leavesOf);
}

function areasOf(node: DockNode): Record<string, CompiledArea> {
    const out: Record<string, CompiledArea> = {};
    for (const leaf of leavesOf(node)) {
        out[leaf.data.id] = {
            id: leaf.data.id,
            visible: leaf.visible ?? true,
            views: [...leaf.data.views],
            activeView: leaf.data.activeView,
        };
    }
    return out;
}

/**
 * 编译结果 → dockview `fromJSON` 的入参。
 *
 * 这里是唯一的一处类型转换：dockview 的 `Orientation` 是**运行时枚举**（值就是我们写的那两个字符串），
 * 导进来会把 dockview 拖进纯模型层（node 单测里它要碰 DOM）。值相同，只差类型。
 */
export function toSerialized(layout: CompiledLayout): SerializedDockview {
    return {
        grid: layout.grid as unknown as SerializedDockview['grid'],
        panels: layout.panels,
        activeGroup: layout.activeGroup,
    };
}

/** 给测试和调试用：`col(row[left | center | right] | bottom)` */
export function summarize(node: DockNode): string {
    if (node.type === 'leaf') {
        const hidden = node.visible === false ? ',hidden' : '';
        return `${node.data.id}[${node.data.views.join('|')}${hidden}]`;
    }
    return `(${node.data.map(summarize).join(' ; ')})`;
}
