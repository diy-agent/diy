// AreaHost.tsx —— 布局渲染器。**唯一的渲染逻辑**，而且它很短。
//
// 为什么这么短：这个模型的全部规则是「骨架固定 + area 可折叠成条 + area 内 view 换形态」。
//   · 没有拖拽换位 ⇒ 没有 reorder / 落点判定 / 快照兼容那一堆；
//     只有沿模板已有边界的宽度伸缩（`Resizer`，它改不了骨架）
//   · 没有关闭 ⇒ 不会出现「组被删、区域没了」（dockview 版那个死锁在这套模型里不可能发生）
//   · 没有浮动 / 最大化 ⇒ 没有 overlay 层与它的 z-index 战场
//
// 「收起」有两种表现方式（`chrome`，全局偏好）：
//   · `bar`   —— 页顶一条标题栏（`TitleBar`）：整宽、**横跨导航**，两端放区域开关（只有图标，
//                文字在 tooltip）。收起 = 完全不占位（主区吃掉空间），恢复入口在标题栏里。
//   · `strip` —— **不渲染标题栏**（页顶不多一条，这才是这种模式的意义）：区域自己收成
//                竖条 / 横条（方向随它所在的 row / column），点条就展开。回切入口是右下角浮钮。
// 两种共用同一份「谁收起了」，只换表现形式 —— 所以随时可以切换，状态不丢。
//
// **主区域不参与收起**：每页声明一个 `main`（`PageDef.main`），它是这一页的组织中心，
// 收起它等于把这一页收没了。标题栏不给它按钮，strip 模式也不给它折叠按钮。
//
// 渲染永远是「模板 → 区域 → 该区有哪些 view → 按形态摊开」这一条单向链，
// 宿主只额外记三样用户偏好：区域收起、形态、tab 选中。

import { roomTitle, useRoomDialogsContext, useSelectedRoom } from '@diy-agent/entity-chat';
import {
    createContext,
    Fragment,
    useContext,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';

import {
    activeOf,
    areasOf,
    initialState,
    loadChrome,
    loadState,
    MODE_LABEL,
    modeOf,
    modesOf,
    saveChrome,
    saveState,
    sidesOf,
    sizeOf as sizeOfDef,
    viewsIn,
    type AreaDef,
    type Chrome,
    type LayoutNode,
    type Mode,
    type PageDef,
    type PageState,
    type Side,
    type ViewDef,
} from './model';

/** 区域控制面：折叠 / 形态 / tab 选中（全部在区域自己身上，宿主只读不摆） */
export interface WbApi {
    readonly page: PageDef;
    /** 主区域 id：永远展开，不参与收起 */
    readonly main: string;
    /** 每个非主区 area 相对主区的方位（模板推导，标题栏据此分组） */
    readonly sides: ReadonlyMap<string, Side>;
    /** 收起的表现方式（全局偏好） */
    readonly chrome: Chrome;
    setChrome: (chrome: Chrome) => void;
    isOpen: (areaId: string) => boolean;
    toggleArea: (areaId: string) => void;
    modeOf: (areaId: string) => Mode;
    allowedModes: (areaId: string) => readonly Mode[];
    setMode: (areaId: string, mode: Mode) => void;
    activeOf: (areaId: string) => string | undefined;
    setActive: (areaId: string, viewId: string) => void;
    /** 该区域能放几个 view（页外开关据此显示角标；0 = 这个页没有这块） */
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
    // 表现方式是**全局**偏好（不按页分）：它回答的是「收起长什么样」，不是「这页哪些收了」
    const [chrome, setChrome] = useState<Chrome>(() => loadChrome(storage));

    useEffect(() => {
        saveState(page.type, state, storage);
    }, [state, page.type, storage]);

    useEffect(() => {
        saveChrome(chrome, storage);
    }, [chrome, storage]);

    const defs = useMemo(() => new Map(areasOf(page.layout).map((def) => [def.id, def])), [page.layout]);
    const sides = useMemo(() => sidesOf(page), [page]);

    // 依赖只到「哪些 view 属于哪」这一层：render 函数本身不是状态
    const placementKey = useMemo(
        () => views.map((view) => `${view.id}@${view.placement[page.type]?.area ?? '-'}`).join(','),
        [views, page.type],
    );

    return useMemo<WbApi>(() => {
        const viewsOf = (areaId: string) => viewsIn(views, page.type, areaId);
        return {
            page,
            main: page.main,
            sides,
            chrome,
            setChrome,
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
    }, [page, defs, sides, chrome, state, placementKey]);
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

// ── 图标（标题栏只放图标，文字全进 tooltip）──────────────────────────────────────
//
// 全用 SVG 而不靠字符：几何块 U+25A4… 这类字形在不同字体里宽窄不一，
// 而标题栏是 28px 高的一条，差 1px 就会显得歪。

/** 区域图标：外框 + **指针位置的高亮块**。方位从模板推（`sidesOf`），不手写图标表 */
function AreaGlyph({ side }: { side: Side }) {
    const inner =
        side === 'left'
            ? { x: 2, y: 2, width: 3.5, height: 10 }
            : side === 'right'
              ? { x: 8.5, y: 2, width: 3.5, height: 10 }
              : side === 'top'
                ? { x: 2, y: 2, width: 10, height: 3.5 }
                : { x: 2, y: 8.5, width: 10, height: 3.5 };
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <rect
                x="1.5"
                y="1.5"
                width="11"
                height="11"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.45"
            />
            <rect {...inner} rx="1" fill="currentColor" />
        </svg>
    );
}

/** 导航：三条横线（就是「列表」的意思） */
function NavGlyph() {
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M2.5 4h9M2.5 7h9M2.5 10h9" />
            </g>
        </svg>
    );
}

/** 设置：齿轮（圆 + 八辐） */
function GearGlyph() {
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                <path d="M7 1.6v1.6M7 10.8v1.6M1.6 7h1.6M10.8 7h1.6M3.2 3.2l1.13 1.13M9.67 9.67l1.13 1.13M10.8 3.2L9.67 4.33M4.33 9.67L3.2 10.8" />
            </g>
        </svg>
    );
}

// ── 边界手柄（拖宽度，不动骨架）─────────────────────────────────────────────

/** 手柄作为 flex 项的宽度（px）：可见的线就这 1px，命中区靠 CSS 的 ::after 向两侧溢出到 5px */
const HANDLE = 1;

/** 拖动时两侧的最小可闻尺寸（px）：没有 `min` 的区域用这个 */
const FALLBACK_MIN = 120;

/** 另一侧至少还要留多少（px）—— 不能把邻居拖成一条缝 */
const NEIGHBOR_KEEP = 160;

/**
 * 相邻两个子项之间的边界手柄。
 *
 * 拖的**不是骨架**：只让「模板给了固定 px 的那一侧」沿这条边变宽变窄，相邻的 `fr` 自动让位。
 * 两侧都是 `fr` 或都是子树 → 不渲染手柄，因为「拖了该改谁」没有正确答案。
 *
 * 拖动过程直接改 DOM 的 `flex`、松手才提交 state：中间每帧走 React 重渲染会把
 * 整页（含对话虚拟列表）拖到掉帧。
 */
function Resizer({ axis, prev, next }: { axis: 'x' | 'y'; prev: LayoutNode; next: LayoutNode }) {
    const api = useWb();

    const prevDef = 'axis' in prev ? null : prev;
    const nextDef = 'axis' in next ? null : next;
    const prevFixed = prevDef !== null && api.sizeOf(prevDef.id) !== 'fr';
    const nextFixed = nextDef !== null && api.sizeOf(nextDef.id) !== 'fr';

    // 优先调前一个（拖右边界改左边那块，最直觉）；前一个是 fr 才调后一个
    const target = prevFixed ? prevDef : nextFixed ? nextDef : null;
    if (target === null) return null;
    const sign = prevFixed ? 1 : -1;

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        const handle = event.currentTarget;
        const parent = handle.parentElement;
        const from = api.sizeOf(target.id);
        const areaEl = parent?.querySelector<HTMLElement>(`[data-area="${target.id}"]`);
        if (parent === null || areaEl === null || areaEl === undefined || from === 'fr') return;

        const box = parent.getBoundingClientRect();
        const origin = axis === 'x' ? event.clientX : event.clientY;
        const span = axis === 'x' ? box.width : box.height;
        const min = target.min ?? FALLBACK_MIN;
        const max = Math.max(min, span - NEIGHBOR_KEEP);
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
            title="拖动调整宽度（双击复位）"
            onPointerDown={onPointerDown}
            onDoubleClick={() => {
                api.resetSize(target.id);
            }}
        />
    );
}

// ── 区域 → 树 ─────────────────────────────────────────────────────────────────

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

    // 主区永远展开：收起它这一页就没了，所以它既不在标题栏里、也没有折叠按钮
    const isMain = def.id === api.main;
    const bar = api.chrome === 'bar';

    if (!open && !isMain) {
        // bar：整块不占位（空间给主区），恢复入口在标题栏 —— 标题栏永远在，所以不可能找不回来
        // strip：收成一条，位置还在，点条展开
        return bar ? null : <FoldedArea def={def} axis={parentAxis} />;
    }

    // 尺寸：fr 分剩余、px 固定。px 的那几条边可以拖（`Resizer`），拖过的值存在 PageState.sizes
    const size = api.sizeOf(def.id);
    const style: CSSProperties = size === 'fr' ? { flex: '1 1 0px' } : { flex: `0 0 ${String(size)}px` };
    if (def.min !== undefined) {
        if (parentAxis === 'x') style.minWidth = def.min;
        else style.minHeight = def.min;
    }

    // 折叠按钮只在 strip 模式下有：bar 模式的收起动作归标题栏，区域自己不再放第二个入口
    const foldBtn = !isMain && !bar ? <FoldToggle def={def} axis={parentAxis} /> : null;
    const mark = isMain ? 'true' : undefined;

    // 单 view：不画头部（一个 tab 的 tab 条是噪音），也谈不上形态
    if (list.length === 1) {
        return (
            <div className="wb-area" style={style} data-area={def.id} data-main={mark}>
                <div className="wb-body">{list[0]!.render()}</div>
                {foldBtn}
            </div>
        );
    }

    const mode = api.modeOf(def.id);
    return (
        <div className="wb-area" style={style} data-area={def.id} data-mode={mode} data-main={mark}>
            {mode === 'accordion' ? (
                <AccordionLayout areaId={def.id} list={list} />
            ) : mode === 'grid' ? (
                <GridLayout areaId={def.id} list={list} />
            ) : (
                <TabLayout areaId={def.id} list={list} />
            )}
            {foldBtn}
        </div>
    );
}

function NodeView({ node, views, parentAxis }: { node: LayoutNode; views: readonly ViewDef[]; parentAxis: 'x' | 'y' }) {
    if ('axis' in node) {
        const children = node.children;
        return (
            <div className={node.axis === 'x' ? 'wb-split-x' : 'wb-split-y'}>
                {children.map((child, index) => (
                    <Fragment key={'axis' in child ? `split-${String(index)}` : child.id}>
                        {index > 0 && <Resizer axis={node.axis} prev={children[index - 1] ?? child} next={child} />}
                        <NodeView node={child} views={views} parentAxis={node.axis} />
                    </Fragment>
                ))}
            </div>
        );
    }
    return <AreaView def={node} views={views} parentAxis={parentAxis} />;
}

// ── 标题栏 ────────────────────────────────────────────────────────────────────
//
// 整页最顶一条，**图标化**（文字全进 tooltip）：
//   左：[导航] + 主区左侧 / 上方的区域
//   中：房间名（这条件里唯一的文字）
//   右：主区右侧 / 下方的区域 │ [设置] │ [换成折叠条]
//
// **layout 图标贴两端、功能按钮用竖线隔开**：两者性质不同 —— 一个回答「页面怎么摆」，
// 一个回答「应用能干什么」。分组不手写：方位从模板推（`sidesOf`），挪了模板里的区域，
// 按钮自动跟着换边。

/** 导航开关（全局层，由壳持有；标题栏左端放它的按钮） */
export interface NavState {
    open: boolean;
    toggle: () => void;
}

/** 标题栏按钮：**只有图标**（文字在 tooltip）。`on` 缺省 = 中性按钮（如设置） */
function TbIconButton({
    on,
    label,
    onClick,
    children,
}: {
    on?: boolean;
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            className={on === true ? 'wb-tb-btn on' : 'wb-tb-btn'}
            aria-pressed={on}
            title={label}
            aria-label={label}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function TbAreaButton({
    def,
    side,
    open,
    onToggle,
}: {
    def: AreaDef;
    side: Side;
    open: boolean;
    onToggle: () => void;
}) {
    return (
        <TbIconButton on={open} label={`${open ? '收起' : '展开'}「${def.title}」`} onClick={onToggle}>
            <AreaGlyph side={side} />
        </TbIconButton>
    );
}

/**
 * 标题栏 —— 整页最顶一条，**横跨导航**。
 *
 * 名字对齐 VS Code 的 `PART_TITLEBAR` / Theia 的 `ApplicationShell.TOP`：那边放的是
 * 「不属于任何一个编辑器组、但指挥整个窗口」的东西（菜单、命令中心、窗口控件）。
 * 这里放：
 *   左：应用名 + 导航开关 + 主区左侧的区域
 *   中：页名 · 房间名（面包屑）
 *   右：主区右侧 / 下方的区域 + 全局工具 + 表现方式切换
 *
 * **为什么它横跨导航**：它指挥的包括导航本身（左端就有导航开关），
 * 一条要管住所有区域的横条不能住在其中一个区域里面。
 *
 * **为什么它能当「唯一的恢复入口」**：它不在骨架里，而且比导航更外层 ——
 * 任何区域（含导航）收起都不影响它。这正是 dockview 版栽的地方
 * （入口长在被收起的那个东西身上）。
 */
export function TitleBar({ nav, api }: { nav: NavState; api?: WbApi }) {
    const dialogs = useRoomDialogsContext();
    const room = useSelectedRoom();
    const bar = (api?.chrome ?? 'bar') === 'bar';

    // 只列「这个页真有内容」的区域：项目页没有 assets，就不该有它的按钮
    const items = useMemo(() => {
        if (!api) return [];
        return areasOf(api.page.layout)
            .filter((def) => def.id !== api.main && api.viewCountOf(def.id) > 0)
            .map((def) => ({ def, side: api.sides.get(def.id) ?? 'bottom' }));
    }, [api]);
    const left = items.filter((item) => item.side === 'left' || item.side === 'top');
    const right = items.filter((item) => item.side === 'right' || item.side === 'bottom');

    const renderItem = (item: { def: AreaDef; side: Side }) => (
        <TbAreaButton
            key={item.def.id}
            def={item.def}
            side={item.side}
            open={api?.isOpen(item.def.id) ?? false}
            onToggle={() => {
                api?.toggleArea(item.def.id);
            }}
        />
    );

    return (
        <header className="wb-titlebar">
            <div className="wb-tb-group">
                <TbIconButton on={nav.open} label={nav.open ? '收起导航' : '展开导航'} onClick={nav.toggle}>
                    <NavGlyph />
                </TbIconButton>
                {bar && left.length > 0 && <span className="wb-tb-sep" aria-hidden="true" />}
                {bar && left.map(renderItem)}
            </div>

            <div className="wb-tb-mid">
                <span className="wb-tb-name">{room ? roomTitle(room) : ''}</span>
            </div>

            <div className="wb-tb-group wb-tb-group-end">
                {bar && right.map(renderItem)}
                {bar && right.length > 0 && <span className="wb-tb-sep" aria-hidden="true" />}
                <TbIconButton
                    label="设置"
                    onClick={() => {
                        dialogs.openSettings();
                    }}
                >
                    <GearGlyph />
                </TbIconButton>
                {api && (
                    <>
                        <span className="wb-tb-sep" aria-hidden="true" />
                        {/* 只在标题栏模式下出现：折叠条模式根本没有标题栏，
                            回切入口是右下角那个浮钮（见 `ChromeFab`） */}
                        <TbIconButton
                            label="换成折叠条（区域自己收成一条）"
                            onClick={() => {
                                api.setChrome('strip');
                            }}
                        >
                            <AreaGlyph side="left" />
                        </TbIconButton>
                    </>
                )}
            </div>
        </header>
    );
}

/**
 * 一页 = 标题栏（整宽）+ 导航 + 固定骨架。
 *
 * 标题栏和主体是兄弟，都在页层内，但标题栏占满宽度 —— 它的定位是「管住包括导航在内的
 * 所有区域」，所以不能缩在导航右边。
 */
/**
 * 折叠条模式下「换回标题栏」的浮钮。
 *
 * `strip` 模式**不渲染标题栏** —— 那正是这种模式的意义（页顶不多一条）。
 * 但那就没有入口回去了，所以留一个不占位的角标：fixed 定位，盖在页面右下角，
 * 平时低对比度，鼠标过去才出来。它不属于任何一块区域，也就不会被哪个区域收起带走。
 */
function ChromeFab({ api }: { api: WbApi }) {
    return (
        <button
            type="button"
            className="wb-chrome-fab"
            title="换回标题栏（页顶一条，左右放区域开关）"
            aria-label="换回标题栏"
            onClick={() => {
                api.setChrome('bar');
            }}
        >
            <AreaGlyph side="top" />
        </button>
    );
}

/**
 * 一页 = （标题栏 | 浮钮）+ 导航 + 固定骨架。
 *
 * 两种收起方式下页顶不一样高：`bar` 有 28px 的标题栏，`strip` 什么都没有（多出来的
 * 28px 给内容）。这正是用户选它们时的取舍本身。
 */
export function Workbench({
    api,
    views,
    nav,
    navRail,
}: {
    api: WbApi;
    views: readonly ViewDef[];
    nav: NavState;
    navRail: ReactNode;
}) {
    return (
        <Ctx.Provider value={api}>
            {api.chrome === 'bar' ? <TitleBar nav={nav} api={api} /> : null}
            <div className="wb-body">
                {navRail}
                <div className="wb-skeleton">
                    <NodeView node={api.page.layout} views={views} parentAxis="x" />
                </div>
            </div>
            {api.chrome === 'bar' ? null : <ChromeFab api={api} />}
        </Ctx.Provider>
    );
}
