// model.ts —— page / area / view 三概念，**不带任何布局引擎依赖**。
//
// 与之前那套 workbench-dock（dockview）的区别，全在这几条约束里：
//
//   1. 布局**固定**：area 的排列（谁在左、谁在下）与尺寸都由模板写死，用户不能拖、不能分、不能改。
//      → 没有 sash、没有 drag、没有 floating、没有 split。
//   2. view **不可关闭、不可移动**：它声明自己属于哪个 page 的哪个 area，就只能在那儿。
//      → 没有 close 动作、没有「拖到别的组」。
//   3. 唯一可隐藏的是 **area**：隐藏 = 整块不渲染，恢复入口在页外（布局里放不回来）。
//   4. area 内有多个 view 时，排列**形态可配**：tab / 折叠 / 格子。单个 view 不显示 tab 条 ——
//      一个 tab 的 tab 条是纯噪音。
//
// 所以这张表里最重要的其实是「没有」这一列：约束少了，能出错的状态也少了
// （dockview 版里那个「关掉 view ⇒ 组被删 ⇒ area 没了 ⇒ 恢复入口也失效」的死锁，
// 在这套模型下不可能发生 —— view 不可关，area 的身份来自模板而不是「运行时有没有内容」）。

import type { ReactNode } from 'react';

/**
 * area 内多 view 的排列形态。
 *
 * 三种都在「同一块地方」内换排法，**不改变 area 的位置和大小** —— 这正是「把页面布局固定下来」
 * 的意思：动的只有内容怎么摊开，骨架不动。
 */
export type Mode = 'tab' | 'accordion' | 'grid';

export const MODES: readonly Mode[] = ['tab', 'accordion', 'grid'] as const;

export const MODE_LABEL: Record<Mode, string> = {
    tab: '标签页',
    accordion: '折叠',
    grid: '格子',
};

/** 区域定义：只描述「在骨架里的位置与默认呈现」 */
export interface AreaDef {
    id: string;
    /** 区域名。多 view 时显示在头部；页外开关也用它 */
    title: string;
    /** 沿父轴的 px，或 `'fr'`（在兄弟之间分剩余空间） */
    size: number | 'fr';
    min?: number;
    /** 初始是否收起；缺省展开 */
    initial?: 'open' | 'collapsed';
    /** 默认形态；缺省 tab。只在 area 里有多个 view 时生效 */
    mode?: Mode;
    /** 允许的形态；缺省三种全允许，给一个值就是**锁定形态**（该区域不给切换按钮） */
    modes?: readonly Mode[];
}

/** 分割节点：`x` = 左右排，`y` = 上下排 */
export interface SplitDef {
    axis: 'x' | 'y';
    children: LayoutNode[];
}

export type LayoutNode = AreaDef | SplitDef;

export function area(id: string, opts: Omit<AreaDef, 'id' | 'title'> & { title?: string }): AreaDef {
    return { id, title: opts.title ?? id, ...opts };
}

/** 左右排 */
export function row(...children: LayoutNode[]): SplitDef {
    return { axis: 'x', children };
}

/** 上下排 */
export function col(...children: LayoutNode[]): SplitDef {
    return { axis: 'y', children };
}

/** 页模板：布局固定，标题只是给人看的 */
export interface PageDef {
    type: string;
    title: string;
    layout: LayoutNode;
}

export function definePage(page: PageDef): PageDef {
    return page;
}

/**
 * 视图：真正的内容单元。
 *
 * `placement` 是「能进哪些页的哪个区域」——**单向声明**（view 认识 pageType，page 不认识 view）。
 * 没有 `primary`、没有 `closeable`、没有「关闭后怎么办」：不可关闭是这个模型的公理，不是一个选项。
 */
export interface ViewDef {
    id: string;
    title: string;
    placement: Record<string, { area: string }>;
    render: () => ReactNode;
}

export function defineView(view: ViewDef): ViewDef {
    return view;
}

// ── 从模板推导（模板是唯一真源，别再手写一份区域清单）────────────────────────────

/** 树里所有 area，按声明顺序 */
export function areasOf(node: LayoutNode): AreaDef[] {
    if ('axis' in node) return node.children.flatMap(areasOf);
    return [node];
}

/** 某页能给某个区域塞的 view，按声明顺序 */
export function viewsIn(views: readonly ViewDef[], pageType: string, areaId: string): ViewDef[] {
    return views.filter((view) => view.placement[pageType]?.area === areaId);
}

/** 某页能放的 view（不管区域），用来算「这个区域是不是根本没内容」 */
export function viewsOfPage(views: readonly ViewDef[], pageType: string): ViewDef[] {
    return views.filter((view) => view.placement[pageType] !== undefined);
}

// ── 用户状态：只记「开合 / 形态 / 当前 tab」──────────────────────────────────────
//
// 刻意很小 —— 尺寸、位置、分割方式都不在里面，因为它们不可改（那是模板的事）。
// 也刻意**不记 view 的开关**：view 不可关闭，没有「关掉了」这个状态要持久化。

export interface PageState {
    /** 收起的区域 id */
    collapsed: Record<string, true>;
    /** 覆盖模板默认的形态 */
    modes: Record<string, Mode>;
    /** tab 形态下每个区域选中的 view id */
    active: Record<string, string>;
}

/** 偏好键按**页类型**分（不含房间 id）：切房间时骨架不动、偏好也该跟着走 */
export function stateKey(pageType: string): string {
    return `workbench:${pageType}`;
}

/** 读不到（从没存过 / 坏数据）返回 null —— 与「存过一个空状态」区分：后者是用户的意图 */
export function loadState(pageType: string, storage: Storage): PageState | null {
    try {
        const raw = storage.getItem(stateKey(pageType));
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as Partial<PageState>;
        return {
            collapsed: parsed.collapsed ?? {},
            modes: parsed.modes ?? {},
            active: parsed.active ?? {},
        };
    } catch {
        // 坏数据就当没有：布局偏好不值得为它挡住整页
        return null;
    }
}

export function saveState(pageType: string, state: PageState, storage: Storage): void {
    try {
        storage.setItem(stateKey(pageType), JSON.stringify(state));
    } catch {
        // 隐私模式 / 配额满：不影响使用，只是下次打开回到默认
    }
}

/** 模板给的初始状态（没有任何用户偏好时） */
export function initialState(page: PageDef): PageState {
    const collapsed: Record<string, true> = {};
    for (const def of areasOf(page.layout)) {
        if (def.initial === 'collapsed') collapsed[def.id] = true;
    }
    return { collapsed, modes: {}, active: {} };
}

/** 该区域允许的形态；`modes` 缺省 = 三种全允许 */
export function modesOf(def: AreaDef): readonly Mode[] {
    return def.modes ?? MODES;
}

/** 该区域当前的形态（用户选的优先，其次模板默认，最后 tab） */
export function modeOf(def: AreaDef, state: PageState): Mode {
    const allowed = modesOf(def);
    const chosen = state.modes[def.id];
    if (chosen !== undefined && allowed.includes(chosen)) return chosen;
    const fallback = def.mode ?? 'tab';
    return allowed.includes(fallback) ? fallback : allowed[0]!;
}

/** 该区域在 tab 形态下显示哪个 view（选中的失效了 = 回第一个） */
export function activeOf(areaId: string, views: readonly ViewDef[], state: PageState): string | undefined {
    const chosen = state.active[areaId];
    if (chosen !== undefined && views.some((view) => view.id === chosen)) return chosen;
    return views[0]?.id;
}
