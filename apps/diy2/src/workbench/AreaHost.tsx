// AreaHost.tsx —— 布局渲染器。**唯一的渲染逻辑**，而且它很短。
//
// 为什么这么短：这个模型的全部规则是「骨架固定 + area 可折叠成条 + area 内 view 换形态」。
//   · 没有拖拽 ⇒ 没有 sash / 命中测试 / 尺寸记账 / 快照兼容那一堆
//   · 没有关闭 ⇒ 不会出现「组被删、区域没了」（dockview 版那个死锁在这套模型里不可能发生）
//   · 没有浮动 / 最大化 ⇒ 没有 overlay 层与它的 z-index 战场
//
// 折叠与「隐藏」的区别（2026-11-23 用户裁）：折叠不是让区域消失，而是**收成一条**，
// 条的横竖跟着它所在的 row / column 走，条上写着区域名，点条就展开。
// 于是宿主不需要页外控制面：恢复入口永远在布局里、在它原来的位置。
//
// 渲染永远是「模板 → 区域 → 该区有哪些 view → 按形态摊开」这一条单向链，
// 宿主只额外记三样用户偏好：区域收起、形态、tab 选中。

import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
    activeOf,
    areasOf,
    initialState,
    loadState,
    MODE_LABEL,
    modeOf,
    modesOf,
    saveState,
    viewsIn,
    type AreaDef,
    type LayoutNode,
    type Mode,
    type PageDef,
    type PageState,
    type ViewDef,
} from './model';

/** 区域控制面：折叠 / 形态 / tab 选中（全部在区域自己身上，宿主只读不摆） */
export interface WbApi {
    readonly page: PageDef;
    isOpen: (areaId: string) => boolean;
    toggleArea: (areaId: string) => void;
    modeOf: (areaId: string) => Mode;
    allowedModes: (areaId: string) => readonly Mode[];
    setMode: (areaId: string, mode: Mode) => void;
    activeOf: (areaId: string) => string | undefined;
    setActive: (areaId: string, viewId: string) => void;
    /** 该区域能放几个 view（页外开关据此显示角标；0 = 这个页没有这块） */
    viewCountOf: (areaId: string) => number;
}

const Ctx = createContext<WbApi | null>(null);

export function useWb(): WbApi {
    const api = useContext(Ctx);
    if (api === null) throw new Error('useWb 必须在 <Workbench> 里用');
    return api;
}

/**
 * 页状态 + 控制面。
 *
 * 存盘的是「用户偏好」，不是「布局」：尺寸 / 位置 / 分割方式不在里面（它们不可改），
 * view 的开合也不在里面（view 不可关闭，没有这个状态）。
 */
export function usePageWorkbench(page: PageDef, views: readonly ViewDef[], storage: Storage = localStorage): WbApi {
    const [state, setState] = useState<PageState>(() => loadState(page.type, storage) ?? initialState(page));

    useEffect(() => {
        saveState(page.type, state, storage);
    }, [state, page.type, storage]);

    const defs = useMemo(() => new Map(areasOf(page.layout).map((def) => [def.id, def])), [page.layout]);

    // 依赖只到「哪些 view 属于哪」这一层：render 函数本身不是状态
    const placementKey = useMemo(
        () => views.map((view) => `${view.id}@${view.placement[page.type]?.area ?? '-'}`).join(','),
        [views, page.type],
    );

    return useMemo<WbApi>(() => {
        const viewsOf = (areaId: string) => viewsIn(views, page.type, areaId);
        return {
            page,
            isOpen: (areaId) => state.collapsed[areaId] !== true,
            toggleArea: (areaId) => {
                setState((prev) => {
                    const collapsed = { ...prev.collapsed };
                    if (collapsed[areaId] === true) delete collapsed[areaId];
                    else collapsed[areaId] = true;
                    return { ...prev, collapsed };
                });
            },
            modeOf: (areaId) => {
                const def = defs.get(areaId);
                return def === undefined ? 'tab' : modeOf(def, state);
            },
            allowedModes: (areaId) => {
                const def = defs.get(areaId);
                return def === undefined ? [] : modesOf(def);
            },
            setMode: (areaId, mode) => {
                setState((prev) => ({ ...prev, modes: { ...prev.modes, [areaId]: mode } }));
            },
            activeOf: (areaId) => activeOf(areaId, viewsOf(areaId), state),
            setActive: (areaId, viewId) => {
                setState((prev) => ({ ...prev, active: { ...prev.active, [areaId]: viewId } }));
            },
            viewCountOf: (areaId) => viewsOf(areaId).length,
        };
        // placementKey 覆盖了 views 里真正被读到的部分
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, defs, state, placementKey]);
}

// ── 形态切换（只在「这个区域有多个 view」且「模板允许多种形态」时出现）────────────────

const MODE_GLYPH: Record<Mode, string> = { tab: '▤', accordion: '☰', grid: '▦' };

function ModeSwitch({ areaId }: { areaId: string }) {
    const api = useWb();
    const allowed = api.allowedModes(areaId);
    if (allowed.length < 2) return null;
    const now = api.modeOf(areaId);
    return (
        <div className="wb-modes" role="group" aria-label="呈现形态">
            {allowed.map((mode) => (
                <button
                    key={mode}
                    type="button"
                    title={`${MODE_LABEL[mode]}（只换摆法，不动骨架）`}
                    aria-label={MODE_LABEL[mode]}
                    aria-pressed={mode === now}
                    onClick={() => {
                        api.setMode(areaId, mode);
                    }}
                >
                    <span aria-hidden="true">{MODE_GLYPH[mode]}</span>
                </button>
            ))}
        </div>
    );
}

// ── 三种形态 ────────────────────────────────────────────────────────────────────

function TabLayout({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    const api = useWb();
    const activeId = api.activeOf(areaId);
    const active = list.find((view) => view.id === activeId) ?? list[0]!;
    return (
        <>
            <div className="wb-head wb-head-tabs">
                <div className="wb-tabs" role="tablist">
                    {list.map((view) => (
                        <button
                            key={view.id}
                            type="button"
                            role="tab"
                            aria-selected={view.id === active.id}
                            className={view.id === active.id ? 'on' : undefined}
                            onClick={() => {
                                api.setActive(areaId, view.id);
                            }}
                        >
                            {view.title}
                        </button>
                    ))}
                </div>
                <ModeSwitch areaId={areaId} />
            </div>
            <div className="wb-body" role="tabpanel">
                {active.render()}
            </div>
        </>
    );
}

function AccordionLayout({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    // 折叠项的开合是**临时视图状态**（不是布局偏好）：关掉页面就忘，不值得存盘。
    // 默认第一个展开 —— 进来总得看见点东西。
    const [open, setOpen] = useState<Record<string, boolean>>(() =>
        list[0] === undefined ? {} : { [list[0].id]: true },
    );
    return (
        <>
            <div className="wb-head">
                <span className="wb-head-title">折叠 · {String(list.length)}</span>
                <ModeSwitch areaId={areaId} />
            </div>
            <div className="wb-body wb-acc">
                {list.map((view) => {
                    const on = open[view.id] === true;
                    return (
                        <section key={view.id} className={on ? 'wb-acc-item on' : 'wb-acc-item'}>
                            <button
                                type="button"
                                className="wb-acc-head"
                                aria-expanded={on}
                                onClick={() => {
                                    setOpen((prev) => ({ ...prev, [view.id]: !on }));
                                }}
                            >
                                <span className="wb-chev" aria-hidden="true">
                                    {on ? '▾' : '▸'}
                                </span>
                                {view.title}
                            </button>
                            {on && <div className="wb-acc-body">{view.render()}</div>}
                        </section>
                    );
                })}
            </div>
        </>
    );
}

function GridLayout({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    return (
        <>
            <div className="wb-head">
                <span className="wb-head-title">格子 · {String(list.length)}</span>
                <ModeSwitch areaId={areaId} />
            </div>
            <div className="wb-body wb-grid">
                {list.map((view) => (
                    <section key={view.id} className="wb-cell">
                        <div className="wb-cell-title">{view.title}</div>
                        <div className="wb-cell-body">{view.render()}</div>
                    </section>
                ))}
            </div>
        </>
    );
}

// ── 区域 → 树 ───────────────────────────────────────────────────────────────────

/** 折叠条沿父轴的厚度（px）。够容下竖排文字的两三个字，又不至于占掉相当于一块内容 */
const FOLD_THICKNESS = 28;

/**
 * 折叠按钮：**每个区域右上角都有一个**，收成一条 / 展开回来。
 *
 * 位置是 absolute（不占内容空间）。多 view 区域的 head 右侧预留了 `padding-right`，
 * 按钮正好落在 head 的空白处；单 view 区域没有 head，按钮浮在内容右上角（hover 显现）。
 */
function FoldToggle({ def, axis }: { def: AreaDef; axis: 'x' | 'y' }) {
    const api = useWb();
    return (
        <button
            type="button"
            className="wb-fold-btn"
            title={`折叠「${def.title}」—— 收成一条，点条展开`}
            aria-label={`折叠${def.title}`}
            aria-expanded
            onClick={() => {
                api.toggleArea(def.id);
            }}
        >
            {/* 往哪个方向收：左右排 → 往左收成竖条；上下排 → 往上收成横条 */}
            <span aria-hidden="true">{axis === 'x' ? '◂' : '▴'}</span>
        </button>
    );
}

/**
 * 折叠后的样子：一条。横竖由**它所在的容器**决定 ——
 * 在 row 里就收成竖条（窄、满高），在 col 里就收成横条（矮、满宽）。
 *
 * 整条就是按钮（不只是箭头）：28px 宽的东西里再分命中区没有意义。
 */
function FoldedArea({ def, axis }: { def: AreaDef; axis: 'x' | 'y' }) {
    const api = useWb();
    const style: CSSProperties = { flex: `0 0 ${String(FOLD_THICKNESS)}px` };
    if (axis === 'x') style.minWidth = FOLD_THICKNESS;
    else style.minHeight = FOLD_THICKNESS;
    return (
        <div className={`wb-area wb-folded wb-folded-${axis}`} style={style} data-area={def.id} data-folded="true">
            <button
                type="button"
                className="wb-fold-strip"
                title={`展开「${def.title}」`}
                aria-label={`展开${def.title}`}
                onClick={() => {
                    api.toggleArea(def.id);
                }}
            >
                <span className="wb-fold-arrow" aria-hidden="true">
                    {axis === 'x' ? '▸' : '▾'}
                </span>
                <span className="wb-fold-name">{def.title}</span>
            </button>
        </div>
    );
}

function AreaView({ def, views, parentAxis }: { def: AreaDef; views: readonly ViewDef[]; parentAxis: 'x' | 'y' }) {
    const api = useWb();
    const open = api.isOpen(def.id);
    const list = useMemo(() => viewsIn(views, api.page.type, def.id), [views, api.page.type, def.id]);

    // 这个页没东西可放 → 不渲染（不是「收起」：连骨架里的位置都没有）
    if (list.length === 0) return null;

    // 收起 = 折叠成一条，位置还在
    if (!open) return <FoldedArea def={def} axis={parentAxis} />;

    // 尺寸：fr 分剩余、px 固定。**没有可拖的手柄** —— 这两个值就是最终值。
    const style: CSSProperties = def.size === 'fr' ? { flex: '1 1 0px' } : { flex: `0 0 ${String(def.size)}px` };
    if (def.min !== undefined) {
        if (parentAxis === 'x') style.minWidth = def.min;
        else style.minHeight = def.min;
    }

    // 单 view：不画头部（一个 tab 的 tab 条是噪音），也谈不上形态
    if (list.length === 1) {
        return (
            <div className="wb-area" style={style} data-area={def.id}>
                <div className="wb-body">{list[0]!.render()}</div>
                <FoldToggle def={def} axis={parentAxis} />
            </div>
        );
    }

    const mode = api.modeOf(def.id);
    return (
        <div className="wb-area" style={style} data-area={def.id} data-mode={mode}>
            {mode === 'accordion' ? (
                <AccordionLayout areaId={def.id} list={list} />
            ) : mode === 'grid' ? (
                <GridLayout areaId={def.id} list={list} />
            ) : (
                <TabLayout areaId={def.id} list={list} />
            )}
            <FoldToggle def={def} axis={parentAxis} />
        </div>
    );
}

function NodeView({ node, views, parentAxis }: { node: LayoutNode; views: readonly ViewDef[]; parentAxis: 'x' | 'y' }) {
    if ('axis' in node) {
        return (
            <div className={node.axis === 'x' ? 'wb-split-x' : 'wb-split-y'}>
                {node.children.map((child, index) => (
                    <NodeView
                        key={'axis' in child ? `split-${String(index)}` : child.id}
                        node={child}
                        views={views}
                        parentAxis={node.axis}
                    />
                ))}
            </div>
        );
    }
    return <AreaView def={node} views={views} parentAxis={parentAxis} />;
}

/** 一页 = 固定骨架 + area 内可配形态 */
export function Workbench({ api, views }: { api: WbApi; views: readonly ViewDef[] }) {
    return (
        <Ctx.Provider value={api}>
            <div className="wb-root">
                <NodeView node={api.page.layout} views={views} parentAxis="x" />
            </div>
        </Ctx.Provider>
    );
}
