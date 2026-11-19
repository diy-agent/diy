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

/**
 * 尺寸。同一个数字在两个时刻含义不同，别混（README「数字尺寸到底是什么」）：
 *
 *  1. **编译那一刻**：数字 = 沿父轴的像素，`'1fr'` = 同父兄弟之间分剩余空间。
 *  2. **容器尺寸变化之后**：不再是像素 —— dockview 按比例重排
 *     （`rescaleViews`：factor = `size / contentSize`，再由 `min` 兜底），
 *     要等下一次编译（重新进页 / scope 变 / 布局结构变）才回到像素。
 *
 * 所以 `size: 300` 的左栏在 1440 宽的窗口里是 300px，同样是这个页、缩到 1000 宽 ≈ 208px；
 * 重新打开它又是 300px。要「永远 300px」得在容器 resize 时重编，那会连用户拖拽和最大化状态
 * 一起抹掉（AGENTS #9），不值当 —— 选择 dockview 的原生语义：**像素只是开页种子**。
 */
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
    /**
     * 最小 px。落成 dockview 的组约束 `minimumWidth` / `minimumHeight`（**同值** —— dockview
     * 按两轴分别约束，DSL 只给一个数，所以它同时是这个区域的高度下限）。
     * 拖不到更小，容器按比例缩放时也压不破它。
     */
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
    /**
     * L1（`editable`）时**额外**允许被拖进的区域；`area` 自己永远允许。
     *
     * 缺省 = 只能待在 `area`：`editable` 打开的是「能拖」，不是「能拖到任何地方」——
     * view 只认识自己声明过的区域，拖进别的区域它就再也说不清自己在哪。
     */
    allow?: string[];
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

/**
 * 非 React view 的命令式契约。
 *
 * 宿主只做三件事：`create` 一次、props 变了调 `update`、销毁时调 `dispose`。
 * element 归 view 所有（自己的 DOM、自己的样式、自己的事件），宿主只负责把它塞进区域。
 */
export interface VanillaView<S extends Scope = Scope> {
    /** view 自己拥有的根元素；挂载时宿主 appendChild，卸载时移除 */
    readonly element: HTMLElement;
    /** props 变了。宿主每次重渲染都可能调，要不要真动 DOM 由 view 自己 diff */
    update?(props: ViewProps<S>): void;
    /** 即将销毁（卸监听 / 关连接）。**必须幂等**：StrictMode 会双挂载，dockview 也可能移动 DOM */
    dispose?(): void;
}

/**
 * view 的渲染方式。判别字段是 `kind`，两条支路都拿到完整 ViewProps（含 `api`）。
 *
 *   react    宿主自带。`component` 是 `ComponentType` —— 包名/导出名写错 tsc 当场报错
 *   vanilla  框架无关。`create(props)` 自己造 DOM —— 代价是放弃 tsc 对组件身份的保护
 *
 * 选 vanilla 是**显式**写在定义里的一次取舍，不是静默降级。
 */
export type ViewRender<S extends Scope = Scope> =
    | { kind: 'react'; component: ComponentType<ViewProps<S>> }
    | { kind: 'vanilla'; create(props: ViewProps<S>): VanillaView<S> };

/** view 的静态定义 */
export interface ViewDef<S extends Scope = Scope> {
    /** 全局唯一的 view id（也是 dockview 的 panel id） */
    id: string;
    title: string | ((scope: S) => string);
    icon?: string;
    /** 能进哪些页的哪个区域（一个 view 可以同时挂多个 pageType） */
    placement: Record<string, Placement>;
    /** 怎么渲染：`kind: 'react'` 走组件，`kind: 'vanilla'` 走命令式契约（见 ViewRender） */
    render: ViewRender<S>;
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
    /** 这个区域此刻是不是最大化状态（不是「有没有区域最大化」—— 一个区域一个答案） */
    isAreaMaximized(areaId: string): boolean;
    /**
     * 模板里有、但此刻没有任何 view 落位的区域（诊断用）。
     *
     * 多半意味着「view 没注册」或「placement 写错了」：这些区域不会出现在布局里，
     * 而模板本身是合法的 —— 所以它不能是错误，只能是一条可查的账。
     */
    skippedAreas(): string[];
    /** 关掉某个 view（从它所在区域移除，并记进 dismissed，模板重编译时不会自己回来） */
    closeView(viewId: string): void;
    /**
     * 把某个 view 开回来（它是 `closeView` 的逆操作）。返回是否真的开了。
     *
     * 三种情况：已经在布局里 → 只激活它；被关掉过 → 从 dismissed 里掸掉再插回它声明的区域；
     * 这个 view 不属于本页 / 它声明的区域不在布局里 → 不动，返回 `false`。
     */
    openView(viewId: string): boolean;
    /** 丢掉用户布局，回到模板（尺寸 / 展开 / 关掉的 view 全部复位） */
    resetLayout(): void;
}

// ── 定义入口（校验都在这里做一次，运行期不再重复检查）────────────────────────────

export function definePage<S extends Scope = Scope>(def: PageDef<S>): PageDef<S> {
    validateAreas(def);
    return { ...def, areas: normalizeAreas(def.areas) };
}

const RENDER_KINDS: readonly string[] = ['react', 'vanilla']; // 供运行期校验；类型上只有这两种

export function defineView<S extends Scope = Scope>(def: ViewDef<S>): ViewDef<S> {
    if (!def.id) throw new ModelError('view.id 不能为空');
    if (Object.keys(def.placement).length === 0) throw new ModelError(`view "${def.id}" 没有任何 placement`);
    const kind = (def.render as { kind?: unknown } | undefined)?.kind;
    if (typeof kind !== 'string' || !RENDER_KINDS.includes(kind)) {
        throw new ModelError(`view "${def.id}": render.kind 必须是 ${RENDER_KINDS.join(' / ')}`);
    }
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
 * 模板里写死数字的叶子（`size: 300`）→ 它沿哪根轴被拉长（`x` = 宽度，`y` = 高度）。
 *
 * 只有这些区域会被用户拖拽改尺寸并记住：`'1fr'` 的叶子不在里面，它吃的是「剩下的空间」，
 * 钉住它等于把某一刻的窗口尺寸烧进布局。根叶子没有父轴，也就不存在可拖的分屏线。
 */
export function pinnedAreas(root: AreaNode, parentAxis?: Axis, out = new Map<string, Axis>()): Map<string, Axis> {
    if (root.type === 'region') {
        if (parentAxis && typeof root.size === 'number') out.set(root.id, parentAxis);
        return out;
    }
    for (const child of root.data.children) pinnedAreas(child, root.data.axis, out);
    return out;
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
