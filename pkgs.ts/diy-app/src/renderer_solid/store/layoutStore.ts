/**
 * layoutStore — 布局层的用户态（area 开合/最大化 + track 尺寸）。
 *
 * 分层（见 133 与 shared/grid-layout）：
 *   静态层 = page 的 layout（代码常量，shared/view-registry）
 *   动态层 = 本 store（用户数据，落视图 cache）
 * 中间没有表达式引擎 —— 这正是与 VSCode 的核心差异。
 *
 * 「线就是线」：track 尺寸是**全局**的，同列/同行的两块共享同一条线，
 * 故拖线会同时影响该线上所有相邻 area（见 grid-layout 的说明）。
 */
import { createSignal } from "solid-js";
import { Caches } from "../lib/ui-state";
import { px, resolveLayout, type Layout, type TrackSize } from "../../shared/grid-layout";
import {
    applyHiddenViews,
    defaultBinding,
    type Binding,
    type PageDef,
} from "../../shared/view-registry";

export interface PageLayoutState {
    /** areaId → 隐藏（最小化）。缺省 = 显示 */
    hidden: Record<string, boolean>;
    /**
     * viewInstanceKey → 隐藏（**view 级**，与上面的 area 级是两层，别混）。
     *
     * 语义与 binding 的 null 一致：隐藏 = 从 area 里拿掉，**实例状态保留**
     * （滚回位置/草稿不丢），再显示时原样回来 —— 见 133「被删 area 上的 view 置
     * binding = null 隐藏而非销毁」。
     *
     * 键是 viewInstanceKey（context 型 view 带 `@ctx`），故「这个任务页隐藏日志」
     * 不会波及别的任务实例。同一 view 挂多个 page 时，各自独立（`chat.local` 在
     * task-run 是中心、在 lab 是卫星，隐藏一个不影响另一个）。
     */
    hiddenViews: Record<string, boolean>;
    /** 被最大化的 area id；null = 正常网格 */
    maximized: string | null;
    /** 用户拖拽后的 track 覆盖（整份）。undefined = 用 page 默认 */
    cols?: TrackSize[];
    rows?: TrackSize[];
}

/** 开发者默认隐藏的 area（注册表声明；用户改过之后以用户态为准） */
import { DEFAULT_HIDDEN } from "../../shared/view-registry";
const defaultHidden = (pageId: string): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of DEFAULT_HIDDEN[pageId] ?? []) out[id] = true;
    return out;
};

/** 无用户记录时的默认态（**不是**空态：空态会丢掉开发者默认布局） */
const defaultState = (pageId: string): PageLayoutState => ({
    hidden: defaultHidden(pageId),
    hiddenViews: {},
    maximized: null,
});

/** 载入时的宽松清洗：结构不对就丢该条，不让脏数据把界面搞乱 */
function load(): Record<string, PageLayoutState> {
    const raw = Caches.diy_layout_state.get();
    const out: Record<string, PageLayoutState> = {};
    for (const [pid, v] of Object.entries(raw ?? {})) {
        if (!v || typeof v !== "object") continue;
        const o = v as Record<string, unknown>;
        const hidden: Record<string, boolean> = {};
        if (o.hidden && typeof o.hidden === "object" && !Array.isArray(o.hidden)) {
            for (const [k, b] of Object.entries(o.hidden as Record<string, unknown>)) {
                if (b === true) hidden[k] = true;
            }
        }
        const tracks = (x: unknown): TrackSize[] | undefined => {
            if (!Array.isArray(x) || x.length === 0) return undefined;
            const ts: TrackSize[] = [];
            for (const t of x) {
                if (!t || typeof t !== "object") return undefined;
                const tt = t as Record<string, unknown>;
                if ((tt.unit !== "px" && tt.unit !== "fr") || typeof tt.value !== "number") return undefined;
                ts.push({ unit: tt.unit, value: tt.value } as TrackSize);
            }
            return ts;
        };
        const hiddenViews: Record<string, boolean> = {};
        if (o.hiddenViews && typeof o.hiddenViews === "object" && !Array.isArray(o.hiddenViews)) {
            for (const [k, b] of Object.entries(o.hiddenViews as Record<string, unknown>)) {
                if (b === true) hiddenViews[k] = true;
            }
        }
        out[pid] = {
            hidden,
            hiddenViews,
            maximized: typeof o.maximized === "string" ? o.maximized : null,
            cols: tracks(o.cols),
            rows: tracks(o.rows),
        };
    }
    return out;
}

const [states, setStates] = createSignal<Record<string, PageLayoutState>>(load());

/**
 * 改某 page 的布局态。
 *
 * ⚠️ 起点必须是 `all[pageId] ?? defaultState(pageId)`，**不能用空态**：
 * 实测踩过 —— 拖拽走 setTrackPair 时若以空态起步，会把 DEFAULT_HIDDEN 一并清掉，
 * 表现为「拖一下线，本该收起的 right/bottom 全冒出来了」。
 */
function patch(pageId: string, mut: (s: PageLayoutState) => PageLayoutState): void {
    setStates((all) => {
        const next = { ...all, [pageId]: mut(all[pageId] ?? defaultState(pageId)) };
        Caches.diy_layout_state.set(next as unknown as Record<string, unknown>);
        return next;
    });
}

export const layoutStore = {
    /** 某 page 的布局用户态（无记录则返回默认空态） */
    pageState(pageId: string): PageLayoutState {
        return states()[pageId] ?? defaultState(pageId);
    },

    /** 某 area 是否隐藏（最小化） */
    isHidden(pageId: string, areaId: string): boolean {
        return layoutStore.pageState(pageId).hidden[areaId] === true;
    },

    setAreaHidden(pageId: string, areaId: string, hidden: boolean): void {
        patch(pageId, (s) => {
            const h = { ...s.hidden };
            if (hidden) h[areaId] = true;
            else delete h[areaId];
            return { ...s, hidden: h };
        });
    },

    toggleArea(pageId: string, areaId: string): void {
        layoutStore.setAreaHidden(pageId, areaId, !layoutStore.isHidden(pageId, areaId));
    },

    /**
     * 本 page **实例**的有效 binding = 注册表默认 + 本页的 view 级隐藏覆盖。
     * 渲染层直接用这个（不要再手拼 defaultBinding，否则 view 隐藏会失效）。
     */
    bindingFor(page: PageDef, ctx: string | null): Binding {
        return applyHiddenViews(defaultBinding(page, ctx), layoutStore.pageState(page.id).hiddenViews);
    },

    /** 某 view 实例是否被隐藏（view 级，与 area 级 isHidden 是两层） */
    isViewHidden(pageId: string, viewKey: string): boolean {
        return layoutStore.pageState(pageId).hiddenViews[viewKey] === true;
    },

    /**
     * 隐藏 / 显示某 view 实例。
     *
     * 与 `ui view expand`（折叠框展开）和 `viewarea.set`（area 开合）是三件不同的事：
     *    expand    → view **内部**的折叠框（模板树 / 变量定义…）
     *    viewarea  → view 所在的 area 整体开合
     *    本方法    → 单个 **view 实例**在 area 里的去留
     */
    setViewHidden(pageId: string, viewKey: string, hidden: boolean): void {
        patch(pageId, (s) => {
            const h = { ...s.hiddenViews };
            if (hidden) h[viewKey] = true;
            else delete h[viewKey];
            return { ...s, hiddenViews: h };
        });
    },

    toggleViewHidden(pageId: string, viewKey: string): void {
        layoutStore.setViewHidden(pageId, viewKey, !layoutStore.isViewHidden(pageId, viewKey));
    },

    /** 最大化某 area（再点一次传 null 恢复） */
    setMaximized(pageId: string, areaId: string | null): void {
        patch(pageId, (s) => ({ ...s, maximized: areaId }));
    },

    toggleMaximized(pageId: string, areaId: string): void {
        const cur = layoutStore.pageState(pageId).maximized;
        layoutStore.setMaximized(pageId, cur === areaId ? null : areaId);
    },

    /**
     * 拖线结果落盘：**只改被拖的那两条 track**（lineIndex-1 与 lineIndex），其余保持。
     *
     * 为什么不是「整份写入」：ViewGrid 传进来的尺寸是**渲染态**（已按 hidden 折叠成 0）。
     * 整份写会把「折叠出来的 0」当成用户尺寸固化下来 —— 之后即使把 area 开回来，
     * 那条 track 也永远停在 0。只写相邻两条则天然避开这个坑。
     */
    setTrackPair(
        pageId: string,
        axis: "col" | "row",
        lineIndex: number,
        values: [number, number],
        base: TrackSize[],
    ): void {
        patch(pageId, (s) => {
            const key = axis === "col" ? "cols" : "rows";
            const cur = s[key]?.length === base.length ? [...s[key]!] : [...base];
            cur[lineIndex - 1] = px(values[0]);
            cur[lineIndex] = px(values[1]);
            return { ...s, [key]: cur };
        });
    },

    /**
     * 有效布局（供渲染与 CLI `ui layout get`；两者必须同源）。
     * `base` 由调用方给（page 的开发者默认），本 store 不知道 page 定义。
     */
    resolve(pageId: string, base: Layout): Layout {
        return resolveLayout(base, layoutStore.pageState(pageId));
    },

    /** 一次性写多列/多行尺寸（CLI `ui layout set --cols a,b,c`）。undefined = 不动该轴 */
    setTracks(pageId: string, cols: TrackSize[] | undefined, rows: TrackSize[] | undefined): void {
        patch(pageId, (s) => ({
            ...s,
            cols: cols ?? s.cols,
            rows: rows ?? s.rows,
        }));
    },

    /** 批量收起 / 展开 area（CLI `ui layout set --hide a,b`） */
    setAreasHidden(pageId: string, areaIds: string[], hidden: boolean): void {
        patch(pageId, (s) => {
            const h = { ...s.hidden };
            for (const id of areaIds) {
                if (hidden) h[id] = true;
                else delete h[id];
            }
            return { ...s, hidden: h };
        });
    },

    /** 回到开发者默认布局（尺寸 + 开合 + 最大化 + view 隐藏） */
    reset(pageId: string): void {
        patch(pageId, () => defaultState(pageId));
    },
};

/** 供拖拽时把「算出来的 px 尺寸」转成 track（保持全 px，避免 fr 抖动） */
export const pxTracks = (values: number[]): TrackSize[] => values.map((v) => px(v));
