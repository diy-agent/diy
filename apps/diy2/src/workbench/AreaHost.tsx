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
// 两块 bar，分工不同：
//
//   · **窗口标题栏**（`Window`，见 `window.tsx`）—— 整宽、横跨导航、**永远在**。
//     里面是应用级按钮（导航 / 设置）与**全部区域开关**（2026-11-23 用户裁：都放右端，
//     不再分两边；方位只剩「画图标」一个用处）。它**不认识 page**：摆什么全由「贡献」
//     决定（依赖倒置）—— 全局壳注册导航 / 设置，本文件注册「这一页有哪些可收起的区域」。
//   · **区域标题栏**（`AreaBar`）—— **每个区域都有**，背景色与折叠后的条一致（`--wb-bg-2`）。
//     单击 = 折叠 / 展开（center 不可收），双击 = 最大化 / 还原；右端 `⋯` 菜单是形态
//     （tab / 折叠 / 格子）。折叠后的条与它是同一个东西被压扁：同色、同厚、同一份手势。
//
// `chrome` 只决定**收起的区域长什么样**，不决定任何 bar 在不在：
//   `bar`   → 收起 = 完全不占位（空间给 center，恢复靠窗口标题栏）；
//   `strip` → 收起 = 留一条（竖条 / 横条，方向随槽位），点条即展开。
// 两种形态只是同一只把手的两副样子，共用「谁收起了」，随时可切、状态不丢。
// 这个偏好**归 window**（跨页共享），由宿主把它当 prop 传进来。
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
import { createPortal } from 'react-dom';

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

// ── 区域头部：每个区域都有，操作也都在它身上 ──────────────────────────────
//
// 2026-11-23 用户定：**每个 viewarea 都有自己的标题栏**，背景色与折叠后的条一致
// （`--wb-bg-2`）—— 于是同一块区域在两种形态下看起来是一回事：展开是带头的方块，
// 收起是同一块被压成一条。行为也统一在这一条 bar 上：
//
//   · 单击 = 最小 / 普通互切（center 不参与：它不可收起；最大化期间单击一律无效）
//   · 双击 = 最大化 / 还原（**只有**这一个动作）
//
// 右端的 `⋯` 菜单装「这块内容怎么摊开」（tab / 折叠 / 格子）。不常驻三个图标：
// 每个区域摆一排太吵，而它只对「有多个 view」有意义。入口仍在**每个区域自己的**头上，
// 因为每个区域都有 bar。

/**
 * 标题栏手势：**双击只管最大化 / 还原，单击只管最小 / 普通互切**。
 *
 * 展开的头、折叠后的条、最大化时的那条 bar **共用同一份** —— 三处的点在语义上是同一件事，
 * 各写一份迟早分叉（2026-11-23 的 bug 就是这么来的：最大化条上单击也还原，跟「单击只切
 * 最小 / 普通」打架）。
 *
 * **不用 `event.detail`、也不监听 `dblclick`**，自己计时：两次 `click` 落在 `DOUBLE_WINDOW`
 * 内就是双击。理由是 `detail` 由浏览器按系统双击间隔（约 500ms）算，跟这里的窗口不可能对齐 ——
 * 用它会多出一片灰区：第二击带 `detail === 2` 却晚于窗口，于是第一击已经「收起」、
 * 第二击又去「最大化」。自己计时就没有灰区：> 窗口的两击就是两次单击。
 *
 *   第一击：挂一个 `DOUBLE_WINDOW` 的定时器，窗口内没有第二击才当作单击执行。
 *   窗口内的第二击：取消挂起的单击，只做最大化 / 还原。
 *   窗口外的第二击：就是新的一次单击（上一击已经执行完了）。
 *
 * 为什么单击非等不可：单击「收起」会让这个元素**消失**（变条或整块不占位），第二击就落到
 * 别的元素上去了。这点延迟是「单击 / 双击同一个目标」的固有代价。
 */
const DOUBLE_WINDOW = 250;

function useBarGesture(def: AreaDef, foldable: boolean) {
    const api = useWb();
    const pending = useRef<number | null>(null);
    // 上一击的时间戳（`-Infinity` = 还没有过，避免页面刚加载时 `now - 0 < 窗口` 误判成双击）
    const lastHit = useRef(Number.NEGATIVE_INFINITY);

    // 卸载（区域被展开、切页）时把挂着的定时器收掉，不然它会在之后对着一个已消失的块 toggle
    useEffect(
        () => () => {
            if (pending.current !== null) window.clearTimeout(pending.current);
        },
        [],
    );

    return (event: ReactMouseEvent<HTMLElement>) => {
        // 点在头里的控件（tab / 菜单按钮）上不算「点头」—— 那是它们自己的事
        const inside = (event.target as Element).closest('button');
        if (inside !== null && inside !== event.currentTarget) return;

        const now = performance.now();
        const isDouble = now - lastHit.current < DOUBLE_WINDOW;
        lastHit.current = now;

        if (isDouble) {
            // 双击只做一件事：最大化 / 还原。挂起的单击必须撤掉，否则它会在最大化的新
            // 布局上再 toggle 一次（就变成「最大化顺手折叠了邻块」）
            if (pending.current !== null) {
                window.clearTimeout(pending.current);
                pending.current = null;
            }
            lastHit.current = Number.NEGATIVE_INFINITY; // 三连击的第三下重新当第一击
            api.setMaximized(api.maximized === def.id ? null : def.id);
            return;
        }

        // 单击：最大化期间无效；center 不可收起 —— 两种都直接不做，连定时器都不必挂
        if (api.maximized !== null || !foldable) return;
        pending.current = window.setTimeout(() => {
            pending.current = null;
            api.toggleArea(def.id);
        }, DOUBLE_WINDOW);
    };
}

/** 多 view 时的 tab 条：区域头与最大化头共用 */
function AreaTabs({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    const api = useWb();
    const activeId = api.activeOf(areaId);
    return (
        <div className="wb-tabs" role="tablist">
            {list.map((view) => (
                <button
                    key={view.id}
                    type="button"
                    role="tab"
                    aria-selected={view.id === activeId}
                    className={view.id === activeId ? 'on' : undefined}
                    onClick={() => {
                        api.setActive(areaId, view.id);
                    }}
                >
                    {view.title}
                </button>
            ))}
        </div>
    );
}

/** 菜单宽度（px）：与 `.wb-menu` 的 CSS 同值，用来算右对齐的位置 */
const MENU_WIDTH = 132;

/**
 * 形态菜单（区域头右端的 `⋯`）。
 *
 * 用 fixed 定位 + portal 画到 body 上：区域自己是 `overflow: hidden` 的，菜单若留在
 * 里面，「格子」那种矮区域会把菜单裁掉半截。
 */
function ModeMenu({ areaId, count }: { areaId: string; count: number }) {
    const api = useWb();
    const allowed = api.allowedModes(areaId);
    const [at, setAt] = useState<{ x: number; y: number } | null>(null);
    const now = api.modeOf(areaId);

    // 点外面 / 按 Esc 就收 —— 菜单是瞬时的，不需要「点确定」
    useEffect(() => {
        if (at === null) return;
        const away = (event: PointerEvent) => {
            const target = event.target as Element | null;
            if (target !== null && target.closest('.wb-menu') !== null) return;
            setAt(null);
        };
        const esc = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setAt(null);
        };
        document.addEventListener('pointerdown', away, true);
        document.addEventListener('keydown', esc);
        return () => {
            document.removeEventListener('pointerdown', away, true);
            document.removeEventListener('keydown', esc);
        };
    }, [at]);

    // 单 view 或模板锁定形态时，形态不是个选择 —— 不给一颗点了没用的按钮
    if (count < 2 || allowed.length < 2) return null;

    return (
        <>
            <button
                type="button"
                className={at === null ? 'wb-area-menu' : 'wb-area-menu on'}
                title="呈现形态（只换摆法，不动骨架）"
                aria-label="呈现形态"
                aria-haspopup="menu"
                aria-expanded={at !== null}
                onClick={(event) => {
                    if (at !== null) {
                        setAt(null);
                        return;
                    }
                    const box = event.currentTarget.getBoundingClientRect();
                    setAt({ x: Math.max(6, box.right - MENU_WIDTH), y: box.bottom + 4 });
                }}
            >
                <span aria-hidden="true">⋯</span>
            </button>
            {at === null
                ? null
                : createPortal(
                      <div className="wb-menu" role="menu" style={{ left: at.x, top: at.y, width: MENU_WIDTH }}>
                          {allowed.map((mode) => (
                              <button
                                  key={mode}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={mode === now}
                                  className={mode === now ? 'on' : undefined}
                                  onClick={() => {
                                      api.setMode(areaId, mode);
                                      setAt(null);
                                  }}
                              >
                                  {MODE_LABEL[mode]}
                              </button>
                          ))}
                      </div>,
                      document.body,
                  )}
        </>
    );
}

/**
 * 区域标题栏：区域名 +（多 view 时）tab 条或形态标注 + 右端 `⋯`。
 *
 * 单 view 也画这一条 —— 「每个区域都有头」是这次改动的要点：它同时是折叠 / 最大化的
 * 命中面，没有头就没有地方点。
 */
function AreaBar({ def, list }: { def: AreaDef; list: ViewDef[] }) {
    const api = useWb();
    const foldable = def.slot !== 'center';
    const gesture = useBarGesture(def, foldable);
    const mode = list.length === 1 ? undefined : api.modeOf(def.id);

    return (
        <div
            className="wb-area-bar"
            data-foldable={foldable ? 'true' : undefined}
            title={foldable ? '单击折叠 / 展开，双击最大化' : '双击最大化'}
            onClick={gesture}
        >
            <span className="wb-area-name">{def.title}</span>
            {mode === 'tab' ? (
                <AreaTabs areaId={def.id} list={list} />
            ) : mode === undefined ? null : (
                <span className="wb-bar-note">
                    {MODE_LABEL[mode]} · {String(list.length)}
                </span>
            )}
            <ModeMenu areaId={def.id} count={list.length} />
        </div>
    );
}

// ── 三种形态 ────────────────────────────────────────────────────────────────────

function TabBody({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    const api = useWb();
    const active = list.find((view) => view.id === api.activeOf(areaId)) ?? list[0]!;
    return (
        <div className="wb-area-body" role="tabpanel">
            {active.render()}
        </div>
    );
}

function AccordionLayout({ list }: { list: ViewDef[] }) {
    // 折叠项的开合是**临时视图状态**（不是布局偏好）：关掉页面就忘，不值得存盘。
    // 默认第一个展开 —— 进来总得看见点东西。
    const [open, setOpen] = useState<Record<string, boolean>>(() =>
        list[0] === undefined ? {} : { [list[0].id]: true },
    );
    return (
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
    );
}

function GridLayout({ list }: { list: ViewDef[] }) {
    return (
        <div className="wb-area-body wb-grid">
            {list.map((view) => (
                <section key={view.id} className="wb-cell">
                    <div className="wb-cell-title">{view.title}</div>
                    <div className="wb-cell-body">{view.render()}</div>
                </section>
            ))}
        </div>
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
 * 折叠后的样子：一条 —— 与展开时的**头部同色同高**（`--wb-bg-2` / 28px），
 * 就是同一个头被压扁了。横竖由**它所在的槽位**决定：左右边收成竖条（窄、满高），
 * 上下边收成横条（矮、满宽）。
 *
 * 整条就是按钮，**不再画展开箭头**：28px 厚的东西里再分命中区没有意义，
 * 箭头也只是一颗多余的圆形按钮。条本身就是操作面（单击展开、双击最大化），
 * 与展开态的头行为一致（同一个 `useBarGesture`）。
 */
function FoldedArea({ def, axis }: { def: AreaDef; axis: 'x' | 'y' }) {
    const gesture = useBarGesture(def, true);

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
                onClick={gesture}
            >
                <span className="wb-fold-name">{def.title}</span>
            </button>
        </div>
    );
}

/**
 * 区域里的内容：单 view 直铺，多 view 按形态摊开。
 *
 * 头部不在这里 —— 它由 `AreaBar` 统一画（每个区域都有，折叠 / 最大化的命中面在它身上）。
 */
function AreaContent({ areaId, list }: { areaId: string; list: ViewDef[] }) {
    const api = useWb();
    if (list.length === 1) return <div className="wb-area-body">{list[0]!.render()}</div>;
    const mode = api.modeOf(areaId);
    if (mode === 'accordion') return <AccordionLayout list={list} />;
    if (mode === 'grid') return <GridLayout list={list} />;
    return <TabBody areaId={areaId} list={list} />;
}

/**
 * 最大化：这一块吃掉整个**骨架**（含 center，用户明确要看这一块），其余全让位。
 *
 * 它不是浮层：没有 overlay、没有 z-index 战场 —— 仍然住在骨架的位置上，只是兄弟都不渲染。
 * 顶部那条与区域头是**同一套手势**（`useBarGesture`）：双击还原，单击无效。
 * 不画单独的圆圈还原按钮 —— 条本身就是那颗按钮。
 */
function MaximizedArea({ def, views }: { def: AreaDef; views: readonly ViewDef[] }) {
    const api = useWb();
    const list = useMemo(() => viewsIn(views, api.page.type, def.id), [views, api.page.type, def.id]);
    // 已最大化：单击无效、双击还原（`foldable` 对这条 bar 无意义，传 false = 不参与收起）
    const gesture = useBarGesture(def, false);

    if (list.length === 0) return null;

    return (
        <div className="wb-area wb-max" data-area={def.id} data-maximized="true">
            <div className="wb-max-bar" title="双击还原到原来的大小" onClick={gesture}>
                <span className="wb-max-name">{def.title}</span>
                {list.length > 1 ? <AreaTabs areaId={def.id} list={list} /> : null}
                <span className="wb-max-hint">最大化 · 双击还原</span>
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

    // 收起入口只有一处：**区域自己的头部**（单击 / 双击），不再另放一颗右上角的按钮
    return (
        <div className="wb-area" style={style} data-area={def.id} data-main={isMain ? 'true' : undefined}>
            <AreaBar def={def} list={list} />
            <AreaContent areaId={def.id} list={list} />
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
