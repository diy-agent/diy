// model.ts —— 页（page）/ 区域（area）/ 视图（view）的领域模型。
//
// 三个概念先立住，剩下全是推导：
//   page  一个领域主概念的一次呈现（一个任务 / 一个项目 / 一次工作流执行）
//   area  布局上的一个格子（左 / 中 / 右 / 底 …）；只管位置，不懂业务
//   view  真正的内容单元（对话 / 详情 / 成员 / 作业 …）；声明自己"能进哪些页的哪个区域"
//
// 依赖方向是 **view → page**（view 认识 pageType，page 一个 view id 都不认识）：
// 加一个 view = 加一个文件；动 page 的模板不需要知道有哪些 view 存在。

import type { ComponentType } from 'react';

/** 尺寸：数字 = px；`'1fr'` = 在同父兄弟之间按比例分剩余空间 */
export type Size = number | `${number}fr`;

/** 排列轴：`x` = 左右排，`y` = 上下排（对应 dockview 的 HORIZONTAL / VERTICAL） */
export type Axis = 'x' | 'y';

/** 页的核心对象。`kind` + `id` 决定 page 实例的身份（可寻址、可并排打开两个任务） */
export interface Scope {
    /** 领域类型：task / project / run … */
    kind: string;
    /** 该领域内的稳定 id（任务 id / 项目 id …） */
    id: string;
    /** 给人看的标题；缺省用 id */
    title?: string;
}

export interface AreaOptions {
    size?: Size;
    /** 最小 px（传给 dockview 的组约束，拖不到更小） */
    min?: number;
    /** 初始展开状态；缺省 open */
    initial?: 'open' | 'collapsed';
    /** 隐藏组头（单 view 的区域可以不要 tab 条） */
    hideHeader?: boolean;
}

export interface SplitOptions {
    size?: Size;
    min?: number;
}

interface AreaNodeBase {
    id: string;
    size: Size;
    min?: number;
}

/** 分割节点：把父区域按 axis 切成 N 份 */
export interface AreaSplit extends AreaNodeBase {
    type: 'split';
    data: {
        axis: Axis;
        children: AreaNode[];
    };
}

/** 叶子节点：真正装 view 的格子 */
export interface AreaLeaf extends AreaNodeBase {
    type: 'region';
    data: {
        initial: 'open' | 'collapsed';
        hideHeader?: boolean;
    };
}

export type AreaNode = AreaSplit | AreaLeaf;

/** 一个区域：叶子节点（布局上的格子） */
export function area(id: string, options: AreaOptions = {}): AreaLeaf {
    return {
        type: 'region',
        id,
        size: options.size ?? '1fr',
        min: options.min,
        data: { initial: options.initial ?? 'open', hideHeader: options.hideHeader },
    };
}

/** 左右排（axis = x） */
export function row(children: AreaNode[], options: SplitOptions = {}): AreaSplit {
    return { type: 'split', id: '', size: options.size ?? '1fr', min: options.min, data: { axis: 'x', children } };
}

/** 上下排（axis = y） */
export function col(children: AreaNode[], options: SplitOptions = {}): AreaSplit {
    return { type: 'split', id: '', size: options.size ?? '1fr', min: options.min, data: { axis: 'y', children } };
}

/** view 在某个 pageType 里的落位 */
export interface Placement {
    /** 落进哪个区域（`area()` 的 id） */
    area: string;
    /** 该区域的默认 tab；同一区域至多一个 */
    primary?: boolean;
    /** 同区域内 tab 排序，小的在前；缺省 1000 */
    order?: number;
}

/** 页的静态定义（模板）。布局模板归 pageType，不归用户 —— 用户只改尺寸 / 展开 / 选中 */
export interface PageDef<S extends Scope = Scope> {
    /** 页类型 id：`task-run` / `project` …（落进 hash 路由与 page 实例 id） */
    type: string;
    title: string | ((scope: S) => string);
    icon?: string;
    /** 区域模板（树，不是网格 —— dockview 的 split 是嵌套的，网格表达不了任意布局） */
    areas: AreaNode;
}

/** view 拿到的运行期信息 */
export interface ViewProps<S extends Scope = Scope> {
    /** 本页的核心对象 */
    scope: S;
    page: PageInfo;
    /** 本 view 所在的区域 id */
    areaId: string;
    /** 区域开关 / 最大化等操作（见 PageApi） */
    api: PageApi;
}

/** view 的静态定义 */
export interface ViewDef<S extends Scope = Scope> {
    /** 全局唯一的 view id（也是 dockview 的 panel id） */
    id: string;
    title: string | ((scope: S) => string);
    icon?: string;
    /** 能进哪些页的哪个区域（一个 view 可以同时挂多个 pageType） */
    placement: Record<string, Placement>;
    component: ComponentType<ViewProps<S>>;
}

export interface PageInfo {
    type: string;
    /** 页实例身份：`task-run@task:t-1` */
    id: string;
    title: string;
    icon?: string;
}

/** 区域控制面：view 里想"把成员列表展开"就调这里；不直接碰 dockview */
export interface PageApi {
    showArea(areaId: string): void;
    hideArea(areaId: string): void;
    toggleArea(areaId: string): void;
    isAreaVisible(areaId: string): boolean;
    /** 最大化某区域（`null` = 退出）；最大化状态单独持久化 */
    maximizeArea(areaId: string | null): void;
    isAreaMaximized(): boolean;
    /** 关掉某个 view（从它所在区域移除，并记进 dismissed，模板重编译时不会自己回来） */
    closeView(viewId: string): void;
    /** 丢掉用户布局，回到模板（尺寸 / 展开 / 关掉的 view 全部复位） */
    resetLayout(): void;
}

// ── 定义入口（校验都在这里做一次，运行期不再重复检查）────────────────────────────

export function definePage<S extends Scope = Scope>(def: PageDef<S>): PageDef<S> {
    validateAreas(def);
    return { ...def, areas: normalizeAreas(def.areas) };
}

export function defineView<S extends Scope = Scope>(def: ViewDef<S>): ViewDef<S> {
    if (!def.id) throw new ModelError('view.id 不能为空');
    if (Object.keys(def.placement).length === 0) throw new ModelError(`view "${def.id}" 没有任何 placement`);
    return def;
}

export class ModelError extends Error {
    override name = 'ModelError';
}

/** 页实例 id（可寻址、可并排：`openPage('task-run', {kind:'task', id:'t1'})`） */
export function pageId(pageType: string, scope: Scope): string {
    return `${pageType}@${scope.kind}:${scope.id}`;
}

export function pageTitle<S extends Scope>(def: PageDef<S>, scope: S): string {
    return typeof def.title === 'function' ? def.title(scope) : def.title;
}

export function viewTitle<S extends Scope>(def: ViewDef<S>, scope: S): string {
    return typeof def.title === 'function' ? def.title(scope) : def.title;
}

/** 某个 view 在该 pageType 里的落位；没有 = 这个 view 不属于这个页 */
export function placementOf<S extends Scope>(view: ViewDef<S>, pageType: string): Placement | undefined {
    return view.placement[pageType];
}

/** 遍历区域树的全部叶子（按树的先序） */
export function areaLeaves(node: AreaNode): AreaLeaf[] {
    if (node.type === 'region') return [node];
    return node.data.children.flatMap(areaLeaves);
}

/**
 * 区域树的硬约束（在 definePage 时校验，运行期不再管）：
 *   A1 叶子 id 唯一（placement 靠它定位）
 *   A2 同一分割下的兄弟轴必须交替 —— dockview 的 grid 按**深度**决定方向（根 HORIZONTAL，
 *      子层 VERTICAL，再下一层又 HORIZONTAL），作者显式写两层 row 是表达不出来的
 */
function validateAreas<S extends Scope>(def: PageDef<S>): void {
    const seen = new Set<string>();
    const walk = (node: AreaNode, parentAxis?: Axis): void => {
        if (node.type === 'region') {
            if (!node.id) throw new ModelError(`page "${def.type}": 区域缺少 id`);
            if (seen.has(node.id)) throw new ModelError(`page "${def.type}": 区域 id "${node.id}" 重复`);
            seen.add(node.id);
            return;
        }
        const axis = node.data.axis;
        if (parentAxis && axis === parentAxis) {
            throw new ModelError(
                `page "${def.type}": 区域树的轴必须交替（dockview 的 grid 按嵌套深度换方向，` +
                    `两层 "${axis}" 是表达不出来的）—— 把它改成 row/col 交替嵌套`,
            );
        }
        if (node.data.children.length === 0) throw new ModelError(`page "${def.type}": 分割节点没有子区域`);
        for (const child of node.data.children) walk(child, axis);
    };
    walk(def.areas);
}

/** 给分割节点补稳定 id（`root` / `root.0` …）：dockview 的 serialized grid 不带 branch id，我们也不依赖它 */
function normalizeAreas(node: AreaNode, path = 'root'): AreaNode {
    if (node.type === 'region') return node;
    return {
        ...node,
        id: node.id || path,
        data: { ...node.data, children: node.data.children.map((child, i) => normalizeAreas(child, `${path}.${i}`)) },
    };
}
