/**
 * ViewGrid — 把 layout + binding 渲染成实际界面（1:1 CSS Grid）。
 *
 * 职责边界（刻意最小）：
 *   本组件管**几何与分组** —— 谁在哪个 area、area 多大、怎么摆、怎么拖。
 *   view 内部长什么样（折叠框 / tab / 菜单条）由 view 自己决定，本组件不插手。
 *
 * 标准设施（每个 area 都有，无例外）：
 *   - 边界拖动条：拖「线」改 track 尺寸。**线是全局的**，同列/同行的块共享它；
 *     被跨列 area 覆盖的段没有分隔可言，故不渲染手柄（见 colLineSegments）
 *   - 最大化 / 最小化：浮在 area 右上角
 */
import { For, Show, createMemo, type JSX } from "solid-js";
import {
    areaCss,
    collapsibleTracks,
    colLineSegments,
    findArea,
    rowLineSegments,
    trackCss,
    px,
    type Layout,
    type TrackSize,
} from "../../shared/grid-layout";
import { findPage, groupViewsByArea, type Binding } from "../../shared/view-registry";
import { ViewBoundary } from "./ViewBoundary";
import { layoutStore } from "../store/layoutStore";

/** 拖线时两侧 track 的最小 px（防止把某块拖没，用户就再也抓不到线了） */
const MIN_TRACK = 48;

export function ViewGrid(props: {
    pageId: string;
    /** page 实例的上下文键（context 型 view 的实例键由它派生） */
    ctx: string | null;
    /** 开发者默认布局；用户拖拽后的覆盖在 layoutStore 里，本组件负责合并 */
    layout: Layout;
    binding: Binding;
    renderView: (viewId: string, areaId: string) => JSX.Element;
}) {
    const page = () => findPage(props.pageId);
    let gridRef: HTMLDivElement | undefined;

    const st = () => layoutStore.pageState(props.pageId);

    /** 有效布局 = 默认 + 用户 track 覆盖 + 隐藏 area 的 track 归零 */
    const layout = createMemo<Layout>(() => {
        const s = st();
        const base = props.layout;
        let cols: TrackSize[] = s.cols?.length === base.cols.length ? s.cols : base.cols;
        let rows: TrackSize[] = s.rows?.length === base.rows.length ? s.rows : base.rows;
        const hiddenIds = Object.keys(s.hidden).filter((id) => s.hidden[id]);
        if (hiddenIds.length > 0) {
            // 只收「该 track 的格子全属已隐藏 area」的那些（见 collapsibleTracks 的教训注释）
            const col = collapsibleTracks(base, new Set(hiddenIds));
            cols = [...cols];
            rows = [...rows];
            for (const i of col.cols) cols[i] = px(0);
            for (const j of col.rows) rows[j] = px(0);
        }
        return { ...base, cols, rows };
    });

    /** 按 area 分组；隐藏的 area 不渲染（其 view 的实例状态由 store 保留） */
    const groups = createMemo(() => {
        const p = page();
        if (!p) return [];
        const s = st();
        return groupViewsByArea(p, props.ctx, props.binding)
            .filter((g) => !s.hidden[g.areaId])
            .map((g) => ({ ...g, rect: findArea(layout(), g.areaId) }));
    });

    const maximized = () => st().maximized;

    /** 该线相邻的 track 是否已被折叠（尺寸 0）→ 拖它无意义，不渲染手柄 */
    const isCollapsed = (axis: "col" | "row", line: number): boolean => {
        const tracks = axis === "col" ? layout().cols : layout().rows;
        return (tracks[line - 1]?.value ?? 0) === 0 || (tracks[line]?.value ?? 0) === 0;
    };

    // ── 拖线 ────────────────────────────────────────
    // 从**已解析的 px 尺寸**起步（getComputedStyle 会算出 fr 的实际像素），
    // 之后整份写成 px —— 拖过之后不再受 fr 重算影响。
    const startDrag = (axis: "col" | "row", lineIndex: number, e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const el = gridRef;
        if (!el) return;
        const cs = getComputedStyle(el);
        const resolved = (axis === "col" ? cs.gridTemplateColumns : cs.gridTemplateRows)
            .split(" ")
            .map((x) => parseFloat(x))
            .filter((x) => Number.isFinite(x));
        if (resolved.length !== (axis === "col" ? props.layout.cols.length : props.layout.rows.length)) return;

        const startPos = axis === "col" ? e.clientX : e.clientY;
        const a0 = resolved[lineIndex - 1]!;
        const b0 = resolved[lineIndex]!;
        const total = a0 + b0;

        const base = axis === "col" ? props.layout.cols : props.layout.rows;
        const move = (ev: MouseEvent) => {
            const delta = (axis === "col" ? ev.clientX : ev.clientY) - startPos;
            let na = Math.round(a0 + delta);
            // 两侧都不许小于下限：撞到下限时把剩余量全给另一侧
            na = Math.max(MIN_TRACK, Math.min(total - MIN_TRACK, na));
            const nb = total - na;
            layoutStore.setTrackPair(props.pageId, axis, lineIndex, [na, nb], base);
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    /** area 右上角的标准设施：最大化 / 最小化 */
    const AreaChrome = (p: { areaId: string }) => (
        <div class="absolute top-0 right-0 z-30 flex opacity-40 hover:opacity-100 transition-opacity">
            <button
                class="btn btn-ghost btn-xs px-1 min-h-0 h-5"
                title={maximized() === p.areaId ? "还原" : "最大化"}
                aria-label={maximized() === p.areaId ? "还原" : "最大化"}
                onClick={(e) => {
                    e.stopPropagation();
                    layoutStore.toggleMaximized(props.pageId, p.areaId);
                }}
            >
                {maximized() === p.areaId ? "🗗" : "⛶"}
            </button>
            <button
                class="btn btn-ghost btn-xs px-1 min-h-0 h-5"
                title="最小化（收起该区域）"
                aria-label="最小化"
                onClick={(e) => {
                    e.stopPropagation();
                    layoutStore.setAreaHidden(props.pageId, p.areaId, true);
                }}
            >
                —
            </button>
        </div>
    );

    const renderArea = (areaId: string) => {
        const g = groups().find((x) => x.areaId === areaId);
        if (!g) return null;
        return (
            <For each={g.views}>
                {(def) => (
                    <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
                        <ViewBoundary viewId={def.id}>{props.renderView(def.id, areaId)}</ViewBoundary>
                    </div>
                )}
            </For>
        );
    };

    return (
        <Show
            when={!maximized()}
            fallback={
                // 最大化：只渲染该 area，填满容器（再点还原回到网格）
                <div class="relative flex flex-col h-full w-full overflow-hidden">
                    <AreaChrome areaId={maximized()!} />
                    {renderArea(maximized()!)}
                </div>
            }
        >
            <div
                ref={(el) => (gridRef = el)}
                class="grid h-full w-full overflow-hidden relative"
                style={{
                    "grid-template-columns": layout().cols.map(trackCss).join(" "),
                    "grid-template-rows": layout().rows.map(trackCss).join(" "),
                }}
            >
                <For each={groups()}>
                    {(g) => (
                        <div
                            // 每个 area 一个独立错误边界：某个 view 抛错不能拖垮整页
                            class="relative overflow-hidden min-w-0 min-h-0 flex flex-col"
                            style={g.rect ? areaCss(g.rect) : undefined}
                        >
                            <AreaChrome areaId={g.areaId} />
                            {renderArea(g.areaId)}
                        </div>
                    )}
                </For>

                {/* 竖线拖拽手柄：每条内部竖线上，只渲染「两侧 owner 不同」的段。
                    相邻 track 已被折叠（尺寸 0）的线不渲染 —— 那条线贴着隐藏的 area，
                    拖它没有可见效果，还会把折叠值写进用户尺寸。 */}
                <For each={layout().cols.slice(0, -1).map((_, i) => i + 1).filter((l) => !isCollapsed("col", l))}>
                    {(line) => (
                        <For each={colLineSegments(layout(), line)}>
                            {(seg) => (
                                <div
                                    class="z-20 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
                                    style={{
                                        "grid-column": `${line + 1} / span 1`,
                                        "grid-row": `${seg.start + 1} / span ${seg.span}`,
                                        "justify-self": "start",
                                        width: "6px",
                                        "margin-left": "-3px",
                                    }}
                                    onMouseDown={(e) => startDrag("col", line, e)}
                                />
                            )}
                        </For>
                    )}
                </For>

                {/* 横线拖拽手柄 */}
                <For each={layout().rows.slice(0, -1).map((_, i) => i + 1).filter((l) => !isCollapsed("row", l))}>
                    {(line) => (
                        <For each={rowLineSegments(layout(), line)}>
                            {(seg) => (
                                <div
                                    class="z-20 cursor-row-resize hover:bg-primary/40 active:bg-primary/60"
                                    style={{
                                        "grid-row": `${line + 1} / span 1`,
                                        "grid-column": `${seg.start + 1} / span ${seg.span}`,
                                        "align-self": "start",
                                        height: "6px",
                                        "margin-top": "-3px",
                                    }}
                                    onMouseDown={(e) => startDrag("row", line, e)}
                                />
                            )}
                        </For>
                    )}
                </For>
            </div>
        </Show>
    );
}
