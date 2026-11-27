// model.ts —— page / area / view 三概念，**不带任何布局引擎依赖**。
//
// 两层结构（2026-11-23 收敛）：
//
//   **Window** —— 上 / 下 / 左 / 右 4 条**可选状态栏** + 中间一个 page（见 `Window.tsx`）。
//   状态栏是全局概念，内容是**贡献**装配出来的（全局按钮 + page 贡献的区域开关），
//   window 不认识任何 page 的业务 —— 它只知道「哪个区域、什么名字、在哪一侧」。
//
//   **Page** —— 内部只有 **5 个固定槽位**：`center` + `top` / `bottom` / `left` / `right`。
//   槽位是**物理位置**，不嵌套（没有 row / col / split 树），不可拖换位置、不可分、不可浮动；
//   区域只能沿相邻边界伸缩（`PageState.sizes`），改不了骨架。
//
// 这个模型里最重要的两条概念：
//
//   1. **center 就是主区域**（不是「可以放主区域的槽之一」）。一页围绕它组织：它必备、
//      永远展开、状态栏里不给它按钮 —— 收起 center 等于把这一页收没了。
//      其余四边都是**可收起的位置**，容纳的是主区的附件（详情 / 资产 / 诊断…）。
//   2. **区域的身份是概念 id，不是方位**。区域声明时给 `id`（`detail` / `assets` / `diag`…），
//      再给 `slot` 说明它现在落在哪个方位。**view / plugin 一律按 id 插入，不按方位插入**
//      （写 `area: 'left'` 就错了：方位会变，概念不会）。反过来，方位改了 id 不变 ——
//      所以「左边那块」挪到右边时，标题栏按钮、偏好键、折叠条上的名字都不必跟着改。
//
// 其余约束（都来自「骨架固定」这一条公理，所以能出错的状态也少）：
//
//   · view **不可关闭、不可移动**：它声明自己进哪个 page 的哪个区域，就只能在那儿。
//   · 唯一能收的是**四边的区域**（center 不在其列）。收起来长什么样由 `Chrome` 决定：
//       `bar`   → 不占位（空间给 center），恢复靠状态栏上的按钮；
//       `strip` → 留一条（方向随槽位），点条即展开（双击最大化）。
//     两种共用同一份 `collapsed`，切换不丢。
//   · 最大化 = 这一块吃掉整个 page，其余全让位；它是临时视图状态，不进 `collapsed`。
//   · 区域内有多个 view 时摆法可配：tab / 折叠 / 格子。单个 view 不画 tab 条。

import type { ReactNode } from 'react';

/** 四边：可以收起的位置。中心不在其中 —— 中心是主区域，见 `PageDef.center` */
export type Side = 'top' | 'bottom' | 'left' | 'right';

/** 槽位：page 里 5 个固定位置的**物理方位** */
export type Slot = Side | 'center';

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

/**
 * 区域定义 = **一个概念**（详情的概念、资产的概念…）+ 它现在占据的位置。
 *
 * `id` 是概念（布局单元 id），`slot` 是位置。贡献者按 `id` 插入 view；
 * 把区域从左侧挪到右侧只改 `slot`，插好的 view 一个都不用动。
 */
export interface AreaDef {
    /** **概念 id**（不是方位）：view / plugin 按它插入；方位改了它也不改 */
    id: string;
    /** 区域名。区域头 / 状态栏按钮的 tooltip / 折叠条都用它 */
    title: string;
    /** 物理方位 */
    slot: Slot;
    /**
     * left / right 是宽度，top / bottom 是高度（px），或 `'fr'`（分剩余空间）。
     * center 用 `'fr'`。拖过的值存在 `PageState.sizes` 里覆盖它。
     */
    size: number | 'fr';
    min?: number;
    /** 初始是否收起；缺省展开。center 收不起来，写了也不生效 */
    initial?: 'open' | 'collapsed';
    /** 默认形态；缺省 tab。只在区域里有多个 view 时生效 */
    mode?: Mode;
    /** 允许的形态；缺省三种全允许，给一个值就是**锁定形态**（该区域不给切换按钮） */
    modes?: readonly Mode[];
    /**
     * 区域标题栏**右端**的宿主扩展（用户 2026-11-24：Astryx / shadcn 那两颗 tab
     * 「上移为 view 级别」）。适用的是「这块区域换一种画法」这类**视图级**开关 ——
     * 它不属于某个 view 内部（那会长在内容顶上多占一行），而是这一块区域本身的属性。
     *
     * 云节点由调用方自己给（本模块是纯数据，不碰状态）：对话区的这一颗在
     * `ConversationAreaBar.tsx`，它自己从 store / dialogs 里取所需。
     */
    bar?: ReactNode;
}

export function area(
    id: string,
    opts: Omit<AreaDef, 'id' | 'slot' | 'title'> & { slot: Slot; title?: string },
): AreaDef {
    return { ...opts, id, title: opts.title ?? id };
}

/** 页模板：**只有槽位上的区域清单**，没有嵌套、没有分割方式可写 */
export interface PageDef {
    type: string;
    title: string;
    /** 中心区域 = 本页主区域：必备、永远展开、不参与收起 */
    center: AreaDef;
    /** 四边的区域，各槽位最多一个 */
    sides: AreaDef[];
    /** `[center, ...sides]`（模板推出来，别再手写一份） */
    areas: AreaDef[];
}

/**
 * 定义页模板。
 *
 * 这里把「一个槽位只有一个区域」「center 的 slot 必须是 center」两条硬约束在**定义时**就检掉：
 * 这些错误写在模板里，运行时表现出来只是「有一块看不见」，排起来极费劲。
 */
export function definePage(def: { type: string; title: string; center: AreaDef; sides?: readonly AreaDef[] }): PageDef {
    const { type, title, center } = def;
    const sides = [...(def.sides ?? [])];
    if (center.slot !== 'center') {
        throw new Error(`页「${type}」的 center「${center.id}」必须声明 slot: 'center'（写的是 '${center.slot}'）`);
    }
    const seen = new Set<string>([center.id]);
    const slots = new Set<Slot>(['center']);
    for (const item of sides) {
        if (item.slot === 'center') {
            throw new Error(`页「${type}」的区域「${item.id}」在 sides 里却声明 slot: 'center'`);
        }
        if (seen.has(item.id)) throw new Error(`页「${type}」的区域 id 重复：${item.id}`);
        if (slots.has(item.slot)) throw new Error(`页「${type}」的槽位 ${item.slot} 上有两个区域`);
        seen.add(item.id);
        slots.add(item.slot);
    }
    return { type, title, center, sides, areas: [center, ...sides] };
}

/**
 * 视图：真正的内容单元。
 *
 * `placement` 是「能进哪些页的哪个区域」——**单向声明**（view 认识 pageType，page 不认识 view），
 * 且**按区域的概念 id 指名**，不按方位（`area: 'left'` 是错的）。
 * 没有 closeable、没有「关闭后怎么办」：不可关闭是这个模型的公理，不是一个选项。
 */
export interface ViewDef {
    /** 区域里唯一（tab 选中、状态持久化都按它）；运行时打开的视图带参数（`unit-detail:catalog-effort`） */
    id: string;
    title: string;
    /** 静态视图靠它声明归属；**运行时打开**的视图不进这里（归属由打开时的 `area` 决定） */
    placement: Record<string, { area: string }>;
    render: () => ReactNode;
    /**
     * 有关闭按钮 = 这行是可关的（只有运行时打开的视图有）。
     * 静态视图**不可关闭**是这个模型的公理：它声明自己在哪就一直在那。
     */
    close?: () => void;
}

/**
 * 运行时打开的视图（用户 2026-11-27：点左边一条需求，在对话旁开一个 tab 放详情）。
 *
 * 它和静态视图的区别只有一条：**谁决定它在不在**。静态的由贡献者声明（不可关），
 * 这种由用户点出来（可关、参数化、按 id 去重 —— 同一条需求不会开出第二个 tab）。
 */
export interface OpenedView {
    /** `kind:主键`（如 `unit-detail:catalog-effort`）：同一个东西只开一次 */
    id: string;
    kind: string;
    title: string;
    /** 开在哪个概念区域（`conversation` = 与对话并列） */
    area: string;
    params: Record<string, string>;
}

export function defineView(view: ViewDef): ViewDef {
    return view;
}

// ── 从模板查（模板是唯一真源，别再手写一份区域清单）────────────────────────────

/** 按概念 id 找区域 */
export function areaOf(page: PageDef, areaId: string): AreaDef | undefined {
    return page.areas.find((def) => def.id === areaId);
}

/** 按方位找区域（center 返回 `page.center`） */
export function areaInSlot(page: PageDef, slot: Slot): AreaDef | undefined {
    return slot === 'center' ? page.center : page.sides.find((def) => def.slot === slot);
}

/**
 * 某页能收起的区域（center 与「这一页没内容的区域」不在此列）—— 状态栏按钮就用它。
 * 顺序 = 模板声明顺序（`[center, ...sides]` 去掉 center）。
 */
export function collapsibleAreas(page: PageDef, hasViews: (areaId: string) => boolean): AreaDef[] {
    return page.sides.filter((def) => hasViews(def.id));
}

/** 某页能给某个区域塞的 view，按声明顺序 */
export function viewsIn(views: readonly ViewDef[], pageType: string, areaId: string): ViewDef[] {
    return views.filter((view) => view.placement[pageType]?.area === areaId);
}

// ── 用户状态：只记「开合 / 形态 / 当前 tab / 拖过的尺寸」──────────────────────────
//
// 刻意很小 —— **位置**与**分割方式**都不在里面，因为它们不可改（那是模板的事）。
// 尺寸只记「用户真拖过的那几个」，没拖过的不占键（模板改默认值仍然生效）。
// 也刻意**不记 view 的开关**：view 不可关闭，没有「关掉了」这个状态要持久化。

/**
 * 区域收起后的**把手形态**（全局偏好，跨页共享）。它只回答「收起来长什么样」，
 * 不改变状态栏 —— 状态栏永远在，两种形态下行为一致：
 *   · `bar`   —— 不占位（空间让给 center，恢复靠状态栏上的按钮）；
 *   · `strip` —— 留一条（竖条 / 横条，点条展开）。
 * 共用同一份 `collapsed`，所以随时可以切、状态不丢。
 */
export type Chrome = 'bar' | 'strip';

const CHROME_KEY = 'workbench:chrome';

export function loadChrome(storage: Storage): Chrome {
    try {
        return storage.getItem(CHROME_KEY) === 'strip' ? 'strip' : 'bar';
    } catch {
        return 'bar';
    }
}

export function saveChrome(chrome: Chrome, storage: Storage): void {
    try {
        storage.setItem(CHROME_KEY, chrome);
    } catch {
        /* 存储不可用：本次运行仍然生效 */
    }
}

export interface PageState {
    /** 收起（两种把手形态共用这一份状态：bar 下是「不占位」，strip 下是「收成一条」） */
    collapsed: Record<string, true>;
    /**
     * 被最大化的区域（临时视图状态，**不进 `collapsed`**）。
     * 有它就只渲染这一块、吃掉整个骨架；清掉即回到 `collapsed` / `sizes` 原样。
     */
    maximized?: string;
    /** 覆盖模板默认的形态 */
    modes: Record<string, Mode>;
    /** tab 形态下每个区域选中的 view id */
    active: Record<string, string>;
    /** 用户拖过的区域尺寸（px，沿相邻边界）。缺省用模板的 `size` */
    sizes: Record<string, number>;
    /**
     * 用户点开过的视图（按打开顺序）。**要存**：tab 是「我正看着的东西」，
     * 刷新一下全没了等于每次都要重新找一遍。
     */
    opened?: OpenedView[];
}

/** 偏好键按**页类型**分（不含房间 id）：切房间时骨架不动、偏好也该跟着走 */
export function stateKey(pageType: string): string {
    return `workbench:${pageType}`;
}

/**
 * 读出来的字段必须是普通对象：手改过 / 旧版本残留的坏值（字符串、数组…）要当成没有。
 * 不检的话，一个 `"collapsed": "oops"` 就能让 `{ ...prev.collapsed }` 展开成字符下标键。
 */
function recordOf<T>(value: unknown): Record<string, T> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return value as Record<string, T>;
}

/** 读不到（从没存过 / 坏数据）返回 null —— 与「存过一个空状态」区分：后者是用户的意图 */
export function loadState(pageType: string, storage: Storage): PageState | null {
    try {
        const raw = storage.getItem(stateKey(pageType));
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
            collapsed: recordOf<true>(parsed.collapsed),
            modes: recordOf<Mode>(parsed.modes),
            active: recordOf<string>(parsed.active),
            sizes: recordOf<number>(parsed.sizes),
            opened: Array.isArray(parsed.opened) ? (parsed.opened as OpenedView[]) : [],
        };
    } catch {
        // 坏数据就当没有：布局偏好不值得为它挡住整页
        return null;
    }
}

export function saveState(pageType: string, state: PageState, storage: Storage): void {
    try {
        // `maximized` **不存盘**：它是「临时看一眼」的视图状态，刷新后回到正常布局更符合直觉
        // （否则下次打开只剩一块，用户会以为布局坏了）。
        const { maximized: _drop, ...rest } = state;
        storage.setItem(stateKey(pageType), JSON.stringify(rest));
    } catch {
        // 隐私模式 / 配额满：不影响使用，只是下次打开回到默认
    }
}

/** 模板给的初始状态（没有任何用户偏好时） */
export function initialState(page: PageDef): PageState {
    const collapsed: Record<string, true> = {};
    for (const def of page.sides) {
        if (def.initial === 'collapsed') collapsed[def.id] = true;
    }
    return { collapsed, modes: {}, active: {}, sizes: {}, opened: [] };
}

/** 区域当前尺寸：用户拖过的优先，其次模板默认。坏值（非正数 / NaN）当没拖过 */
export function sizeOf(def: AreaDef, state: PageState): number | 'fr' {
    const px = state.sizes[def.id];
    return typeof px === 'number' && Number.isFinite(px) && px > 0 ? px : def.size;
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
