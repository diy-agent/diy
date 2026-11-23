// AreaHost.tsx —— 布局渲染器。**唯一的渲染逻辑**，而且它很短。
//
// 为什么这么短：这个模型的全部规则是「骨架固定 + area 可隐藏 + area 内 view 换形态」。
//   · 没有拖拽 ⇒ 没有 sash / 命中测试 / 尺寸记账 / 快照兼容那一堆
//   · 没有关闭 ⇒ 不会出现「组被删、区域没了」（dockview 版那个死锁在这套模型里不可能发生）
//   · 没有浮动 / 最大化 ⇒ 没有 overlay 层与它的 z-index 战场
//
// 渲染永远是「模板 → 区域 → 该区有哪些 view → 按形态摊开」这一条单向链，
// 宿主只额外记三样用户偏好：区域开合、形态、tab 选中。

import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';

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

/** 页外控制面（区域开关住在布局外面 —— 布局里的按钮会跟着区域一起消失） */
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

function AreaView({ def, views, parentAxis }: { def: AreaDef; views: readonly ViewDef[]; parentAxis: 'x' | 'y' }) {
    const api = useWb();
    const open = api.isOpen(def.id);
    const list = useMemo(() => viewsIn(views, api.page.type, def.id), [views, api.page.type, def.id]);

    if (!open || list.length === 0) return null;

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

/** 一页 = 固定骨架 + area 内可配形态。`children` 给宿主挂页级浮层用（弹窗等） */
export function Workbench({ api, views, children }: { api: WbApi; views: readonly ViewDef[]; children?: ReactNode }) {
    return (
        <Ctx.Provider value={api}>
            <div className="wb-root">
                <NodeView node={api.page.layout} views={views} parentAxis="x" />
            </div>
            {children}
        </Ctx.Provider>
    );
}
