// AreaHost.tsx —— 布局渲染器。**唯一的渲染逻辑**，而且它很短。
//
// 为什么这么短：这个模型的全部规则是「5 个固定槽位 + area 可折叠成条 + area 内 view 换形态」。
//   · 没有拖拽换位 ⇒ 没有 reorder / 落点判定 / 快照兼容那一堆；
//     只有沿槽位边界的尺寸伸缩（`Resizer`，它改不了骨架）
//   · 没有关闭 ⇒ 不会出现「组被删、区域没了」（dockview 版那个死锁在这套模型里不可能发生）
//   · 最大化只有一种：这一块吃掉整个骨架、其余让位（`MaximizedArea`）；不是 floating，没有 z-index 战场
//
// 骨架就一条公式：
//
//     [  top   ]
//     [left|center|right]
//     [ bottom ]
//
// `center` 是**主区域**（必备、不参与收起）；四边是可收起的附件，没有就是没这块。
// 区域的 `slot` 决定它落在哪格，**身份是 `id`（概念）而不是方位** —— 所以插 view 认 id，
// 把 detail 从左侧挪到右侧时，view 的声明一行都不用改。
//
// 标题栏（`Window`，见 `window.tsx`）**永远在**，是区域开合的唯一恢复入口：
//   · 它整宽、**横跨导航**，两端放四边区域的开关（只有图标，文字在 tooltip）。
//   · 它**不认识 page**：里面摆什么全由「贡献」决定（依赖倒置）—— 全局壳注册导航 / 设置，
//     本文件注册「这一页有哪些可收起的区域」。加一个按钮 = 多传一份贡献。
//   · `chrome` 只决定**收起的区域长什么样**，不决定标题栏在不在：
//       `bar`   → 收起 = 完全不占位（空间给 center）；
//       `strip` → 收起 = 留一条（竖条 / 横条，方向随槽位），点条即展开。
//   两种形态只是同一只把手的两副样子，共用「谁收起了」，随时可切、状态不丢。
//   这个偏好**归 window**（跨页共享），由宿主把它当 prop 传进来。
//
// 折叠条上：**单击 = 展开，双击 = 最大化**；最大化后那条 28px 的头**双击 = 还原**。
//
// 渲染永远是「模板 → 槽位 → 区域 → 该区有哪些 view → 按形态摊开」这一条单向链，
// 宿主只额外记四样用户偏好：区域收起 / 形态 / tab 选中 / 谁被最大化。

import { roomTitle, useSelectedRoom } from '@diy-agent/entity-chat';
import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';

import {
    activeOf,
    areaInSlot,
    areaOf,
    initialState,
    loadState,
    MODE_LABEL,
    modeOf,
    modesOf,
    saveState,
    sizeOf as sizeOfDef,
    viewsIn,
    type AreaDef,
    type Chrome,
    type Mode,
    type PageDef,
    type PageState,
    type Side,
    type ViewDef,
} from './model';
import { Window, type WindowContribution } from './window';

/** 区域控制面：折叠 / 形态 / tab 选中（全部在区域自己身上，宿主只读不摆） */
export interface WbApi {
    readonly page: PageDef;
    /** 被最大化的区域 id；null = 没在最大化 */
    readonly maximized: string | null;
    /** 最大化 / 还原（传同一个 id 就是切换；传 null = 还原） */
    setMaximized: (areaId: string | null) => void;
    isOpen: (areaId: string) => boolean;
    toggleArea: (areaId: string) => void;
    modeOf: (areaId: string) => Mode;
    allowedModes: (areaId: string) => readonly Mode[];
    setMode: (areaId: string, mode: Mode) => void;
    activeOf: (areaId: string) => string | undefined;
    setActive: (areaId: string, viewId: string) => void;
    /** 该区域能放几个 view（标题栏据此显示开关；0 = 这个页没有这块） */
    viewCountOf: (areaId: string) => number;
    /** 区域当前尺寸（拖过的优先，其次模板默认） */
    sizeOf: (areaId: string) => number | 'fr';
    setSize: (areaId: string, px: number) => void;
    /** 去掉拖过的尺寸 —— 回到**模板**的默认（不是回某个固定值） */
    resetSize: (areaId: string) => void;
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

    // 区域清单来自模板（center + 四边），这里只建索引
    const defs = useMemo(() => new Map(page.areas.map((def) => [def.id, def])), [page]);

    // 依赖只到「哪些 view 属于哪」这一层：render 函数本身不是状态
    const placementKey = useMemo(
        () => views.map((view) => `${view.id}@${view.placement[page.type]?.area ?? '-'}`).join(','),
        [views, page.type],
    );

    return useMemo<WbApi>(() => {
        const viewsOf = (areaId: string) => viewsIn(views, page.type, areaId);
        return {
            page,
            maximized: state.maximized ?? null,
            setMaximized: (areaId) => {
                setState((prev) => {
                    const next = prev.maximized === (areaId ?? undefined) ? undefined : (areaId ?? undefined);
                    if (next === prev.maximized) return prev;
                    const draft: PageState = { ...prev };
                    if (next === undefined) delete draft.maximized;
                    else draft.maximized = next;
                    return draft;
                });
            },
            isOpen: (areaId) => state.collapsed[areaId] !== true,
            toggleArea: (areaId) => {
                setState((prev) => {
                    const collapsed = { ...prev.collapsed };
                    if (collapsed[areaId] === true) delete collapsed[areaId];
                    else collapsed[areaId] = true;
                    // 手动开关区域 = 退出最大化（否则“我点了它怎么没反应”）：
                    // 最大化期间标题栏按钮仍在，它们必须能直接回到普通布局
                    const draft: PageState = { ...prev, collapsed };
                    delete draft.maximized;
                    return draft;
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
            sizeOf: (areaId) => {
                const def = defs.get(areaId);
                return def === undefined ? 'fr' : sizeOfDef(def, state);
            },
            setSize: (areaId, px) => {
                setState((prev) => ({ ...prev, sizes: { ...prev.sizes, [areaId]: px } }));
            },
            resetSize: (areaId) => {
                setState((prev) => {
                    if (prev.sizes[areaId] === undefined) return prev;
                    const sizes = { ...prev.sizes };
                    delete sizes[areaId];
                    return { ...prev, sizes };
                });
            },
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
            <div className="wb-area-body" role="tabpanel">
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
            <div className="wb-area-body wb-acc">
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
            <div className="wb-area-body wb-grid">
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

// ── 边界手柄（拖尺寸，不动骨架）───────────────────────────────────────────────

/** 手柄作为 flex 项的宽度（px）：可见的线就这 1px，命中区靠 CSS 的 ::after 向两侧溢出到 5px */
const HANDLE = 1;

/** 拖动时两侧的最小可闻尺寸（px）：没有 `min` 的区域用这个 */
const FALLBACK_MIN = 120;

/** 另一侧至少还要留多少（px）—— 不能把邻居拖成一条缝 */
const NEIGHBOR_KEEP = 160;

/**
 * 槽位边界手柄。**每条边界最多调一侧**，而且必须是「模板给了固定 px 的那一侧」：
 *
 *   · left | center 之间 → 只调 left；center | right 之间 → 只调 right；
 *   · top / mid 之间 → 只调 top；mid / bottom 之间 → 只调 bottom。
 *
 * center 自己永不调（它是 `fr`，占剩余）；四边是 `fr` 时也不给手柄 ——
 * 两个 `fr` 之间「拖了该改谁」没有正确答案，而骨架固定本来就是这套模型的意思。
 *
 * `sign` = 拖动方向与尺寸变化的关系：+1 = 往右/下拖变大，-1 = 反过来。
 *
 * 拖动过程直接改 DOM 的 `flex`、松手才提交 state：中间每帧走 React 重渲染会把
 * 整页（含对话虚拟列表）拖到掉帧。
 */
function Resizer({ axis, target, sign }: { axis: 'x' | 'y'; target: AreaDef; sign: 1 | -1 }) {
    const api = useWb();

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        const handle = event.currentTarget;
        const parent = handle.parentElement;
        const from = api.sizeOf(target.id);
        if (parent === null || from === 'fr') return;
        const areaEl = parent.querySelector<HTMLElement>(`[data-area="${target.id}"]`);
        if (areaEl === null) return;

        // 邻居 = 边界另一侧那块（target 自己占的那侧不算）。上限按**邻居实测尺寸**算：
        // 用父容器 span 会把「这条边以外的第三块」也算进可让空间里，拖到底会突然跳一步。
        const prevEl = handle.previousElementSibling as HTMLElement | null;
        const neighborEl = (
            prevEl?.dataset.area === target.id ? handle.nextElementSibling : prevEl
        ) as HTMLElement | null;
        const neighborBox = neighborEl?.getBoundingClientRect();
        const box = parent.getBoundingClientRect();

        const origin = axis === 'x' ? event.clientX : event.clientY;
        const neighborSpan =
            neighborBox === undefined
                ? axis === 'x'
                    ? box.width
                    : box.height
                : axis === 'x'
                  ? neighborBox.width
                  : neighborBox.height;
        const min = Math.min(target.min ?? FALLBACK_MIN, Math.round(from));
        const max = Math.max(min, Math.round(from) + Math.max(0, Math.round(neighborSpan) - NEIGHBOR_KEEP));
        let last = Math.round(from);

        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        // 拖动期间整页光标/选区归手柄：鼠标快过元素边界时也不变成文本光标
        document.body.classList.add('wb-resizing', `wb-resizing-${axis}`);

        const move = (ev: PointerEvent) => {
            const delta = (axis === 'x' ? ev.clientX : ev.clientY) - origin;
            last = Math.min(max, Math.max(min, Math.round(from + sign * delta)));
            areaEl.style.flex = `0 0 ${String(last)}px`;
        };
        const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
            document.body.classList.remove('wb-resizing', `wb-resizing-${axis}`);
            // 松手提交一次：存盘，并让所有读 sizeOf 的地方（含折叠条宽度）同步
            api.setSize(target.id, last);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    };

    return (
        <div
            className={`wb-resizer wb-resizer-${axis}`}
            style={{ flex: `0 0 ${String(HANDLE)}px` }}
            role="separator"
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            title="拖动调整尺寸（双击复位）"
            onPointerDown={onPointerDown}
            onDoubleClick={() => {
                api.resetSize(target.id);
            }}
        />
    );
}

// ── 区域 → 骨架 ────────────────────────────────────────────────────────────────

/** 折叠条沿伸缩轴的厚度（px）。够容下竖排文字的两三个字，又不至于占掉相当于一块内容 */
const FOLD_THICKNESS = 28;

/** 区域的伸缩轴：上下边是 y，左右边与中心是 x */
function axisOf(def: AreaDef): 'x' | 'y' {
    return def.slot === 'top' || def.slot === 'bottom' ? 'y' : 'x';
}

/**
 * 折叠按钮：**四边的区域右上角各有一个**，收成一条 / 展开回来。
 *
 * 位置是 absolute（不占内容空间）。多 view 区域的 head 右侧预留了 `padding-right`，
 * 按钮正好落在 head 的空白处；单 view 区域没有 head，按钮浮在内容右上角（hover 显现）。
 * center 没有这个按钮：它不参与收起。
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
 * 折叠后的样子：一条。横竖由**它所在的槽位**决定 ——
 * 左右边收成竖条（窄、满高），上下边收成横条（矮、满宽）。
 *
 * 整条就是按钮（不只是箭头）：28px 宽的东西里再分命中区没有意义。
 *
 * **单击 = 展开，双击 = 最大化**。区分靠 `event.detail`：单击要延迟 `SINGLE_CLICK_DELAY`
 * 才执行（否则双击时第一下已经把条撤了，第二下根本落不到它身上，双击永远不可能发生）。
 * 这点延迟是这个交互不可避免的代价。
 */
const SINGLE_CLICK_DELAY = 180;

function FoldedArea({ def, axis }: { def: AreaDef; axis: 'x' | 'y' }) {
    const api = useWb();
    const pending = useRef<number | null>(null);

    // 卸载（区域被展开、切页）时把挂着的定时器收掉，不然它会在之后对着一个已消失的条 toggle
    useEffect(
        () => () => {
            if (pending.current !== null) window.clearTimeout(pending.current);
        },
        [],
    );

    const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (pending.current !== null) {
            window.clearTimeout(pending.current);
            pending.current = null;
        }
        if (event.detail > 1) {
            api.setMaximized(def.id);
            return;
        }
        pending.current = window.setTimeout(() => {
            pending.current = null;
            api.toggleArea(def.id);
        }, SINGLE_CLICK_DELAY);
    };

    const style: CSSProperties = { flex: `0 0 ${String(FOLD_THICKNESS)}px` };
    if (axis === 'x') style.minWidth = FOLD_THICKNESS;
    else style.minHeight = FOLD_THICKNESS;
    return (
        <div className={`wb-area wb-folded wb-folded-${axis}`} style={style} data-area={def.id} data-folded="true">
            <button
                type="button"
                className="wb-fold-strip"
                title={`单击展开「${def.title}」，双击最大化`}
                aria-label={`展开${def.title}（双击最大化）`}
                onClick={onClick}
            >
                <span className="wb-fold-arrow" aria-hidden="true">
                    {axis === 'x' ? '▸' : '▾'}
                </span>
                <span className="wb-fold-name">{def.title}</span>
            </button>
        </div>
    );
}

/** 区域里的内容：单 view 直铺，多 view 按形态摊开（骨架在这里不参与） */
function AreaContent({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    const api = useWb();
    // 单 view：不画头部（一个 tab 的 tab 条是噪音），也谈不上形态
    if (list.length === 1) return <div className="wb-area-body">{list[0]!.render()}</div>;
    const mode = api.modeOf(areaId);
    if (mode === 'accordion') return <AccordionLayout areaId={areaId} list={list} />;
    if (mode === 'grid') return <GridLayout areaId={areaId} list={list} />;
    return <TabLayout areaId={areaId} list={list} />;
}

/**
 * 最大化：这一块吃掉整个**骨架**（含 center，用户明确要看这一块），其余全让位。
 *
 * 它不是浮层：没有 overlay、没有 z-index 战场 —— 仍然住在骨架的位置上，
 * 只是兄弟都不渲染。顶部一条 28px 的头就是**还原入口**：双击它、或点右边的按钮。
 */
function MaximizedArea({ def, views }: { def: AreaDef; views: readonly ViewDef[] }) {
    const api = useWb();
    const list = useMemo(() => viewsIn(views, api.page.type, def.id), [views, api.page.type, def.id]);
    if (list.length === 0) return null;
    return (
        <div className="wb-area wb-max" data-area={def.id} data-maximized="true">
            <div
                className="wb-max-bar"
                title="双击还原"
                onDoubleClick={() => {
                    api.setMaximized(null);
                }}
            >
                <span className="wb-max-name">{def.title}</span>
                <span className="wb-max-hint">双击还原</span>
                <button
                    type="button"
                    className="wb-max-exit"
                    title="还原"
                    aria-label="还原布局"
                    onClick={() => {
                        api.setMaximized(null);
                    }}
                >
                    <span aria-hidden="true">◱</span>
                </button>
            </div>
            <AreaContent areaId={def.id} list={list} />
        </div>
    );
}

/**
 * 一个槽位上的区域。`def` 可能不存在（模板没给这个槽位）或没内容（这一页没给它 view）——
 * 两种都不渲染，也不占位。
 */
function AreaView({
    def,
    views,
    chrome,
}: {
    def: AreaDef | undefined;
    views: readonly ViewDef[];
    /** 收起后的样子（window 偏好，宿主传下来；本文件不持有它） */
    chrome: Chrome;
}) {
    const api = useWb();
    const list = useMemo(
        () => (def === undefined ? [] : viewsIn(views, api.page.type, def.id)),
        [views, api.page.type, def],
    );

    if (def === undefined || list.length === 0) return null;

    const axis = axisOf(def);
    const isMain = def.slot === 'center';
    const bar = chrome === 'bar';

    if (!isMain && !api.isOpen(def.id)) {
        // bar：整块不占位（空间给 center），恢复入口在标题栏 —— 标题栏永远在，不可能找不回来
        // strip：收成一条，位置还在，点条展开（双击最大化）
        return bar ? null : <FoldedArea def={def} axis={axis} />;
    }

    // 尺寸：fr 分剩余、px 固定。px 的那几条边可以拖（`Resizer`），拖过的值存在 PageState.sizes
    const size = api.sizeOf(def.id);
    const style: CSSProperties = size === 'fr' ? { flex: '1 1 0px' } : { flex: `0 0 ${String(size)}px` };
    if (def.min !== undefined) {
        if (axis === 'x') style.minWidth = def.min;
        else style.minHeight = def.min;
    }

    // 折叠按钮只在 strip 模式下有：bar 模式的收起动作归标题栏，区域自己不再放第二个入口
    const foldBtn = !isMain && !bar ? <FoldToggle def={def} axis={axis} /> : null;
    const mode = list.length === 1 ? undefined : api.modeOf(def.id);

    return (
        <div
            className="wb-area"
            style={style}
            data-area={def.id}
            data-mode={mode}
            data-main={isMain ? 'true' : undefined}
        >
            <AreaContent areaId={def.id} list={list} />
            {foldBtn}
        </div>
    );
}

/**
 * 骨架本体 = 5 个固定槽位拼出来的三行。
 *
 * 手柄与区域**同层插入**（拖动的实质是改同层兄弟的 flex），所以顺序必须是
 * `区域 → 手柄 → 区域`；`Resizer` 靠 `previousElementSibling` 找邻居，见它自己的注释。
 */
function Skeleton({ api, views, chrome }: { api: WbApi; views: readonly ViewDef[]; chrome: Chrome }) {
    const page = api.page;
    const maxDef = api.maximized === null ? undefined : areaOf(page, api.maximized);

    // 最大化时只渲染那一块：它的头就是还原入口，所以其余全让位是安全的
    if (maxDef !== undefined) return <MaximizedArea def={maxDef} views={views} />;

    const top = areaInSlot(page, 'top');
    const bottom = areaInSlot(page, 'bottom');
    const left = areaInSlot(page, 'left');
    const right = areaInSlot(page, 'right');

    // 手柄只在「这块真有内容 + 展开着 + 尺寸是固定 px」时才画：
    // fr 的一侧与 center 分剩余空间，拖它改谁没有正确答案（比例就是模板的意思）。
    const draggable = (def: AreaDef | undefined): def is AreaDef =>
        def !== undefined &&
        def.slot !== 'center' &&
        api.viewCountOf(def.id) > 0 &&
        api.isOpen(def.id) &&
        api.sizeOf(def.id) !== 'fr';

    return (
        <div className="wb-skel">
            <AreaView def={top} views={views} chrome={chrome} />
            {draggable(top) && <Resizer axis="y" target={top} sign={1} />}
            <div className="wb-mid">
                <AreaView def={left} views={views} chrome={chrome} />
                {draggable(left) && <Resizer axis="x" target={left} sign={1} />}
                <AreaView def={page.center} views={views} chrome={chrome} />
                {draggable(right) && <Resizer axis="x" target={right} sign={-1} />}
                <AreaView def={right} views={views} chrome={chrome} />
            </div>
            {draggable(bottom) && <Resizer axis="y" target={bottom} sign={-1} />}
            <AreaView def={bottom} views={views} chrome={chrome} />
        </div>
    );
}

// ── 页壳装配（宿主侧）──────────────────────────────────────────────────────────
//
// 这里做**唯一一件 window 不该做的事**：把「页面有什么」翻译成贡献。
// window 只收到 `areas: [{ id, title, side, open, onToggle }]` —— 它不知道这些区域
// 属于哪个页、里面装什么，因为「这一页有没有资产」是页自己的事（模板说了算）。

/**
 * 一页 = **窗口（标题栏，永远在）** + 导航 + 固定骨架。
 *
 * 标题栏和主体是兄弟，但标题栏占满宽度 —— 它管的是**包括导航在内的**所有东西，
 * 不能缩在导航右边。它也**不随 `chrome` 消失**：那是唯一能找回收起区域的地方，
 * 让它跟着形态走就是 dockview 版那个死锁（入口长在被收起的那个东西身上）。
 *
 * 依赖方向（见 `window.tsx` 文件头）：
 *   · `global` —— 应用壳注册的贡献（导航开关 / 设置…），本文件只转发，不解释；
 *   · `page`   —— 本文件按模板算出来的（这一页有哪些可收起的区域 + 面包屑）。
 */
export function Workbench({
    api,
    views,
    navRail,
    global,
    chrome,
    onChromeChange,
}: {
    api: WbApi;
    views: readonly ViewDef[];
    /** 导航本体（全局层：宽度与收起跨页类型共享，不进页模板） */
    navRail: ReactNode;
    /** 全局层贡献：应用壳注册的按钮，页不解释 */
    global: readonly WindowContribution[];
    /** 收起后的样子（window 偏好，骨架与标题栏共用同一位源） */
    chrome: Chrome;
    onChromeChange: (chrome: Chrome) => void;
}) {
    const room = useSelectedRoom();

    // 页贡献：只列「这一页真有内容」的四边区域 —— 项目页没有 assets，就不该有它的按钮。
    // 判据一律是概念 id，方位只决定按钮落在左端还是右端。
    // `sides` 里的 slot 不会是 center（`definePage` 已校验），所以这个 `as Side` 是安全的。
    const page = useMemo<WindowContribution>(
        () => ({
            id: 'page',
            title: room ? roomTitle(room) : null,
            areas: api.page.sides
                .filter((def) => api.viewCountOf(def.id) > 0)
                .map((def) => ({
                    id: def.id,
                    title: def.title,
                    side: def.slot as Side,
                    open: api.isOpen(def.id),
                    onToggle: () => {
                        api.toggleArea(def.id);
                    },
                })),
        }),
        [api, room],
    );

    // 全局在前：左端因此是「导航 │ 区域」，右端是「区域 │ 工具 │ 把手」
    const contributions = useMemo(() => [...global, page], [global, page]);

    return (
        <Ctx.Provider value={api}>
            <Window contributions={contributions} chrome={chrome} onChromeChange={onChromeChange} />
            <div className="wb-body">
                {navRail}
                <Skeleton api={api} views={views} chrome={chrome} />
            </div>
        </Ctx.Provider>
    );
}
