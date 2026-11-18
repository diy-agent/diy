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
    type Placement,
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
    /**
     * 用户钉住的尺寸（px）。只有模板里写死数字的叶子会被记住 ——
     * `'1fr'` 表达的是「我不决定这块多宽」，它的值永远由**当前** viewport 和兄弟算出来，
     * 所以不能钉（钉住就等于把某一刻的窗口尺寸烧进布局）。
     */
    pinned?: Record<string, number>;
    /**
     * L1 拖出来的落点：view id → 区域 id。
     *
     * 只认「这个 view 自己声明过」的区域（`area` 或 `allow`），其余一律当没发生 ——
     * 这份数据来自快照（用户改过 / 模板改过），不能因为它把一个 view 丢进黑洞。
     */
    moved?: Record<string, string>;
}

/** 用户布局的持久化形态。除了 dockview 快照，只需要多记三样东西 */
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
    /**
     * 用户亲手拖出来的 px：区域 id → 它沿父轴的尺寸。缺省（旧快照没有这个字段）= 全按模板。
     *
     * 为什么不直接读快照里的 `size`：那份 `size` 是**当时那次编译**的产物，混着
     * 用户拖拽、dockview 的钳制、以及上一次窗口尺寸的痕迹，事后分不清哪个是用户要的。
     */
    pinnedSizes?: Record<string, number>;
    /** L1 拖过的 view：view id → 它此刻待的区域（落点仍受 `placement.area` + `allow` 约束） */
    movedViews?: Record<string, string>;
}

/** panel 内容组件名（所有 view 共用一个 React 外壳，靠 params.viewId 分发） */
export const VIEW_COMPONENT = 'view';

// ── 1. 模板 → 布局 ──────────────────────────────────────────────────────────

export function compileLayout<S extends Scope>(input: LayoutInput<S>): CompiledLayout {
    const { page, views, scope, viewport } = input;
    const slots = collectSlots(page, views, scope, input.moved);

    const skippedAreas: string[] = [];
    const root = compileNode(page.areas, slots, depthAxis(page.areas), viewport, skippedAreas, input.pinned);
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
    moved?: Record<string, string>,
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
        // L1 的落点也在这里验：允许拖进一个不存在的区域，等于让用户拖到一个黑洞里
        for (const allowed of placement.allow ?? []) {
            if (!known.has(allowed)) {
                throw new ModelError(
                    `view "${view.id}" 的 placement.allow 里有个 page "${page.type}" 不存在的区域 "${allowed}"`,
                );
            }
        }
        // L1 拖过的 view 落回它自己拖去的地方；没拖过 / 拖到的区域它没声明过 → 回模板位置
        const areaId = movedArea(placement, moved?.[view.id]);
        const slot = slots.get(areaId) ?? { areaId, views: [] };
        slot.views.push(view);
        if (placement.primary) {
            if (slot.activeView) throw new ModelError(`page "${page.type}" 的区域 "${areaId}" 有多个 primary view`);
            slot.activeView = view.id;
        }
        slots.set(areaId, slot);
    }
    for (const slot of slots.values()) {
        slot.views.sort((a, b) => order(a, page.type) - order(b, page.type));
        slot.activeView ??= slot.views[0]?.id;
    }
    void scope;
    return slots;
}

/** 拖动后的落点：只认声明过的区域（`area` + `allow`），其余当没拖过 */
function movedArea(placement: Placement, target: string | undefined): string {
    if (!target || target === placement.area) return placement.area;
    return (placement.allow ?? []).includes(target) ? target : placement.area;
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
    pinned?: Record<string, number>,
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

    // 先把子节点编出来，**只让活下来的**分尺寸：被跳过的区域（没有 view 落位）不该占一份，
    // 否则它那一份会变成一个洞，dockview 的 proportionalLayout 会把剩下的组按比例放大去填，
    // 于是「实测尺寸」永远对不上「模板尺寸」（记账、min 约束、测试都跟着错）
    const compiled = node.data.children.map((child) => ({
        child,
        node: compileNode(child, slots, node.data.axis, viewport, skipped, pinned),
    }));
    const survivors = compiled.filter(
        (entry): entry is { child: AreaNode; node: DockNode } => entry.node !== null,
    );
    if (survivors.length === 0) return null;
    const sizes = distribute(
        survivors.map((entry) => pinnedSize(entry.child, pinned)),
        inner,
    );
    survivors.forEach((entry, index) => {
        entry.node.size = sizes[index];
    });
    return { type: 'branch', data: survivors.map((entry) => entry.node), size: px(node.size, own) };
}

/**
 * 一个兄弟在模板里的尺寸，用户钉过就用钉住值。
 * `fr` 一律按模板走 —— 它是「吃掉剩下的」，被钉住就不再是 fr 了（见 SavedLayout.pinnedSizes）。
 */
function pinnedSize(node: AreaNode, pinned?: Record<string, number>): Size {
    if (!pinned || typeof node.size !== 'number') return node.size;
    return pinned[node.id] ?? node.size;
}

/**
 * 一组兄弟的尺寸：数字是 px，`fr` 分剩余空间，最后**归一**到父容器。
 *
 * 归一不是美化：dockview 的 `proportionalLayout` 会把一组兄弟按比例拉满父容器。
 * 如果留个洞（比如被跳过的区域、或者全都是数字时剩下的空间），**它会替我们做这件事** ——
 * 于是编译出来的 px 和渲染出来的 px 不是一回事，拖动记账（逻辑尺寸 + 位移）跟着失真。
 * 所以该做的事我们自己先做完。
 */
function distribute(sizes: Size[], available: number): number[] {
    let fixed = 0;
    let totalFr = 0;
    for (const size of sizes) {
        fixed += asPx(size) ?? 0;
        totalFr += frOf(size);
    }
    const rest = Math.max(0, available - fixed);
    const raw = sizes.map((size) => asPx(size) ?? (totalFr > 0 ? (rest * frOf(size)) / totalFr : 0));
    if (raw.length === 0) return raw;

    const sum = raw.reduce((acc, value) => acc + value, 0);
    if (sum <= 0) return raw.map(() => 0);
    const scaled = raw.map((value) => Math.max(0, Math.round((value * available) / sum)));

    // 取整误差补给最后一个非零项，让和**正好**等于父容器（否则每层都少几像素，往下累计）
    const drift = Math.round(available) - scaled.reduce((acc, value) => acc + value, 0);
    if (drift !== 0) {
        let last = scaled.length - 1;
        while (last > 0 && scaled[last] === 0) last -= 1;
        scaled[last] = Math.max(0, scaled[last] + drift);
    }
    return scaled;
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
 *   R1 旧布局里有这个区域  → 保留展开状态、tab 顺序、activeView（尺寸看 pinnedSizes）
 *   R2 新模板有、旧布局没有 → 用模板的尺寸与 initial
 *   R3 旧布局有、新模板没有 → 丢弃（模板删了该区域）
 *   R4 view：旧布局 − 已关掉的     → 保留
 *          view：模板有、旧布局没有 → 按 order 插进它声明的区域
 *          view：旧布局有、注册表没有 → 丢弃（代码里删了）
 *
 * 快照不可信（用户改过 localStorage / 旧版本写坏了 / 手拼的）→ 当没存过，回模板。
 * 宁可从模板重来，也不要拿着畸形树去 `fromJSON` 把整页掀了。
 */
export function resolveLayout<S extends Scope>(input: ResolveInput<S>): CompiledLayout {
    const saved = input.saved;
    const usable = saved && saved.pageType === input.page.type ? savedRoot(saved) : null;
    // 快照里的两份用户意图（钉住的尺寸 / 拖动过的落点）都是「优先于模板」的输入
    const compiled = compileLayout({
        ...input,
        pinned: usable ? saved?.pinnedSizes : undefined,
        moved: usable ? saved?.movedViews : undefined,
    });
    if (!usable) return compiled;

    const dismissed = new Set(Array.isArray(saved?.dismissed) ? saved.dismissed : []);
    const prev = new Map<string, PrevLeaf>();
    for (const leaf of leavesOf(usable)) {
        if (leaf.data.id) prev.set(leaf.data.id, leaf);
    }

    const merged = mergeNode(compiled.grid.root, prev, dismissed, orderById(input));
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
        saved?.dock.activeGroup && areas[saved.dock.activeGroup] ? saved.dock.activeGroup : compiled.activeGroup;

    return { ...compiled, grid: { ...compiled.grid, root: merged }, panels, activeGroup, areas };
}

/** view id → 它在**这个页**里的 order（决定新 tab 插进哪一位） */
function orderById<S extends Scope>(input: LayoutInput<S>): Map<string, number> {
    const out = new Map<string, number>();
    for (const view of input.views) {
        const placement = placementOf(view, input.page.type);
        if (placement) out.set(view.id, placement.order ?? 1000);
    }
    return out;
}

/** 快照里的 grid 根节点；形状不对就返回 null（当没存过） */
function savedRoot(saved: SavedLayout): DockNode | null {
    const root = (saved.dock as { grid?: { root?: unknown } } | undefined)?.grid?.root;
    return isDockNode(root) ? root : null;
}

/** dockview 的 grid 树形状校验：只看到我们写得出来的东西，别的一律不认 */
function isDockNode(node: unknown): node is DockNode {
    if (!node || typeof node !== 'object') return false;
    const candidate = node as { type?: unknown; size?: unknown; data?: unknown };
    if (typeof candidate.size !== 'number' || !Number.isFinite(candidate.size)) return false;
    if (candidate.type === 'leaf') {
        const data = candidate.data as { id?: unknown; views?: unknown } | undefined;
        if (!data || typeof data.id !== 'string') return false;
        if (!Array.isArray(data.views) || !data.views.every((view) => typeof view === 'string')) return false;
        return true;
    }
    if (candidate.type === 'branch') {
        const data = candidate.data;
        return Array.isArray(data) && data.length > 0 && data.every(isDockNode);
    }
    return false;
}

/** 旧布局的叶子（形状同 AreaLeafNode；分开命名只为读起来清楚） */
type PrevLeaf = AreaLeafNode;

function mergeNode(
    node: DockNode,
    prev: Map<string, PrevLeaf>,
    dismissed: Set<string>,
    order: Map<string, number>,
): DockNode | null {
    if (node.type === 'leaf') {
        const id = node.data.id;
        const before = prev.get(id);
        // 模板里剩下的 view = 注册表里还有的（模板是编译出来的）− 用户关掉的
        const templateViews = node.data.views.filter((viewId) => !dismissed.has(viewId));
        if (templateViews.length === 0) return null;
        // 顺序：旧布局的 tab 顺序优先；模板里新加的按 order 插进它该在的位置
        const views = mergeViews(
            templateViews,
            (before?.data.views ?? []).filter((viewId) => templateViews.includes(viewId)),
            order,
        );
        const activeView =
            before?.data.activeView && views.includes(before.data.activeView) ? before.data.activeView : views[0];
        return {
            ...node,
            // 尺寸**只**来自编译结果（它已经吃过 pinnedSizes）—— 快照里的 size 一律不采信
            visible: before ? (before.visible ?? true) : node.visible,
            data: { ...node.data, views, activeView },
        };
    }

    const children = node.data
        .map((child) => mergeNode(child, prev, dismissed, order))
        .filter((child): child is DockNode => child !== null);
    if (children.length === 0) return null;
    return { ...node, data: children };
}

/**
 * tab 顺序合并：旧布局的相对顺序不动，新 view 按 order 插到「第一个 order 比它大的旧 view」前面。
 *
 * 拿 `templateViews` 而不是旧数组当基准：它已经是按 order 排好的（compile 的产物），
 * 所以只需要把 `kept` 里的顺序**重新施加**一遍。
 */
function mergeViews(templateViews: string[], kept: string[], order: Map<string, number>): string[] {
    const merged = [...kept];
    for (const viewId of templateViews) {
        if (merged.includes(viewId)) continue;
        const mine = order.get(viewId) ?? 1000;
        const at = merged.findIndex((other) => (order.get(other) ?? 1000) > mine);
        if (at === -1) merged.push(viewId);
        else merged.splice(at, 0, viewId);
    }
    return merged;
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
