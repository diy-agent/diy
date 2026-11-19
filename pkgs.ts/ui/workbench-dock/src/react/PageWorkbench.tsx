// PageWorkbench.tsx —— 一个 page 实例的渲染器（React + dockview）。
//
// 它只做四件事，业务一律不进来：
//   1. 量容器 → compile/resolve 布局（纯函数，见 compile.ts）
//   2. fromJSON 灌给 dockview
//   3. 布局变化 → 存（可选）
//   4. 把 PageApi 递给 view（开关区域 / 最大化 / 关 view / 重置）
//
// 一个 page 实例一个组件实例：切页 = 换 key（`key={pageId}`），布局各自独立。

import {
    DockviewReact,
    type DockviewApi,
    type DockviewReadyEvent,
    type DockviewTheme,
    type IDockviewPanelProps,
} from 'dockview-react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactElement,
} from 'react';
import {
    compileLayout,
    leafGroups,
    leavesOf,
    resolveLayout,
    toSerialized,
    VIEW_COMPONENT,
    type CompiledLayout,
    type SavedLayout,
    type Viewport,
} from '../compile.js';
import {
    pageId,
    pageTitle,
    pinnedAreas,
    placementOf,
    scopeKey,
    viewTitle,
    type AreaNode,
    type PageApi,
    type PageDef,
    type PageInfo,
    type Scope,
    type SharedState,
    type VanillaView,
    type ViewDef,
    type ViewProps,
} from '../model.js';
import { createSharedState } from '../shared.js';
import { PageContext, usePage } from './context.js';

/** 布局持久化的最小接口（localStorage / 后端 KV 都满足） */
export interface LayoutStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface PageWorkbenchProps<S extends Scope = Scope> {
    page: PageDef<S>;
    /** 本页要用的 view（`defineView` 的产物）；缺省 = 全部注册过的 */
    views: readonly ViewDef<S>[];
    /** 本页的核心对象 */
    scope: S;
    /** 传了就持久化布局；不传 = 每次进页回到模板 */
    storage?: LayoutStorage;
    /** 覆盖缺省存的键（缺省 `workbench-dock:<pageType>@<kind>:<id>`；`shareLayout` 时 `workbench-dock:<pageType>`） */
    storageKey?: string;
    /**
     * 模板级共享布局：同一 pageType 的**所有**页实例读同一份快照（缺省按实例各存一份）。
     *
     * 关掉严格归属（`SavedLayout.scopeKey` 不再校验），缺省存储键也降成按 pageType。
     * 想要「所有任务页共用一种摆法」才开：尺寸、关掉的 view、拖过的落点也一并共享。
     */
    shareLayout?: boolean;
    /** L1：允许拖 view 换区域（缺省 false = L0，只能拖分屏线 + 收起/展开 + 关/开 tab） */
    editable?: boolean;
    /** dockview 主题（缺省用它的内置浅色；暗色由宿主用 --dv-* 变量调） */
    theme?: DockviewTheme;
    className?: string;
    /** 每次布局变化（已节流到一帧） */
    onLayoutChange?(saved: SavedLayout): void;
    /**
     * 布局存不下时（localStorage 配额满 / 隐私模式 / 后端 KV 拒绝）。
     *
     * 存不下不影响这一页继续用，但**下次进来会回到模板**—— 所以不能静默当成功。
     */
    onStorageError?(error: unknown): void;
}

export function PageWorkbench<S extends Scope>(props: PageWorkbenchProps<S>): ReactElement {
    const { page, views, scope, editable = false, theme, className } = props;

    // scope / page / views 常被调用方写成内联对象 —— 所以**布局**只认内容签名（见 layoutSignature），
    // 而**传给 view 的 props** 走 context 拿最新值。两件事分开：scope 里任何字段变了，
    // view 立刻看得见，但布局不会因为对象换了个身份就重建。
    const pageInfo = useMemo<PageInfo>(
        () => ({ type: page.type, id: pageId(page.type, scope), title: pageTitle(page, scope), icon: page.icon }),
        [page, scope],
    );
    const storageKey =
        props.storageKey ?? (props.shareLayout ? `workbench-dock:${page.type}` : `workbench-dock:${pageInfo.id}`);

    const hostRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<DockviewApi | null>(null);
    /** 已把布局灌进 dockview（之后的「当前布局」从 api 读，不再读 storage） */
    const appliedRef = useRef(false);
    /** 正在 fromJSON：这期间 dockview 抛的布局事件是副作用，不是用户操作 */
    const applyingRef = useRef(false);
    const dismissedRef = useRef<string[]>([]);
    const maximizedRef = useRef<string | null>(null);
    /** 用户拖出来的 px（只记模板里写死数字的区域，见 compile.ts 的 pinnedSizes） */
    const pinnedRef = useRef<Record<string, number>>({});
    /** 用户拖出来的比例（整组都是叶子的组，见 compile.ts 的 shares） */
    const sharesRef = useRef<Record<string, number>>({});
    /** L1 拖过的 view：view id → 区域 id（落点仍受 `placement.area` + `allow` 约束） */
    const movedRef = useRef<Record<string, string>>({});
    /** 当前吃进 dockview 的编译结果（给 `skippedAreas()` 这类诊断用） */
    const layoutRef = useRef<CompiledLayout | null>(null);
    /**
     * 页内共享状态（`PageApi.shared`）：一个页实例一个槽。
     *
     * 用 ref 而不是 state：它一变不能让 PageWorkbench 重渲染（那会把新 context 推给所有 panel，
     * 而「哪个 view 关心哪个 key」是 view 自己的事 —— 订阅在 `useShared` 里）。
     * 所以 `api` 能永远保持同一个引用，panel 也不会因为选中项变了而重挂。
     */
    const sharedRef = useRef<SharedState | null>(null);
    const shared = sharedRef.current ?? (sharedRef.current = createSharedState());
    /** 布局变化存盘用 */
    const saveFrameRef = useRef(0);
    /**
     * 拖动分屏线之前的实测尺寸（pointerdown 时拍一张，见 `recordDraggedSizes`）。
     * 它存在 = 「用户正在拖尺寸」；不存在 = 这条 geometry 事件不是用户改的。
     */
    const dragBeforeRef = useRef<Record<string, { width: number; height: number }> | null>(null);
    const sizeRef = useRef<Viewport | null>(null);
    const [sized, setSized] = useState(false);
    /** dockview 实例就绪（onReady 已拿到 api） */
    const [ready, setReady] = useState(false);
    /** 这一页摆不出布局时的错误文案（白屏 → 一条可读的信息 + 一个回到模板的按钮） */
    const [crash, setCrash] = useState<string | null>(null);

    // view 外壳与 PageApi 都通过 ref 读最新值：dockview 的 components 必须身份稳定，
    // 重建会卸载所有 panel（React Compiler 下尤其容易踩）
    const viewsRef = useRef(views);
    viewsRef.current = views;
    const pageRef = useRef(page);
    pageRef.current = page;
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const propsRef = useRef(props);
    propsRef.current = props;
    const storageKeyRef = useRef(storageKey);
    storageKeyRef.current = storageKey;
    /** 可被用户拖动尺寸的区域（模板里写死数字的那些） */
    const pinnedAreasRef = useRef(pinnedAreas(page.areas));
    pinnedAreasRef.current = pinnedAreas(page.areas);

    const layoutKey = layoutSignature(page, views, scope);
    // 标题和布局无关：文案变了只改 tab 标题（见下面那个 effect），不重建
    const titleKey = views.map((view) => viewTitle(view, scope)).join('\u0001');

    /** 当前布局 → 要存的东西。全走 ref，所以这个回调的引用永远不变 */
    const currentSaved = useCallback((): SavedLayout | null => {
        const api = apiRef.current;
        if (!api) return null;
        const current = scopeRef.current;
        return {
            version: 1,
            pageType: pageRef.current.type,
            scopeKey: scopeKey(current),
            dock: api.toJSON(),
            dismissed: dismissedRef.current,
            maximizedArea: maximizedRef.current ?? undefined,
            pinnedSizes: pinnedRef.current,
            shares: sharesRef.current,
            movedViews: movedRef.current,
        };
    }, []);

    const persist = useCallback(() => {
        if (applyingRef.current) return;
        const saved = currentSaved();
        if (!saved) return;
        const { storage: store, onLayoutChange, onStorageError } = propsRef.current;
        if (store) {
            try {
                store.setItem(storageKeyRef.current, JSON.stringify(saved));
            } catch (error) {
                // 配额满 / 隐私模式 / 后端拒写：这一页照常用，但不能假装存上了（也会把错误
                // 从 rAF 回调里抛出去 —— 那个位置的异常没人接）
                onStorageError?.(error);
            }
        }
        onLayoutChange?.(saved);
    }, [currentSaved]);

    /** 删快照（"回到模板" / 快照坏了）。存储本身也可能闹脾气，一律不让它冒泡 */
    const clearStored = useCallback(() => {
        try {
            propsRef.current.storage?.removeItem(storageKeyRef.current);
        } catch (error) {
            propsRef.current.onStorageError?.(error);
        }
    }, []);

    const queuePersist = useCallback(() => {
        if (saveFrameRef.current) return;
        saveFrameRef.current = requestAnimationFrame(() => {
            saveFrameRef.current = 0;
            persist();
        });
    }, [persist]);

    const loadSaved = useCallback((): SavedLayout | null => {
        const raw = propsRef.current.storage?.getItem(storageKeyRef.current);
        if (!raw) return null;
        let saved: SavedLayout;
        try {
            saved = JSON.parse(raw) as SavedLayout;
        } catch {
            return null; // 存坏了 → 当没存过
        }
        if (!saved || saved.version !== 1 || saved.pageType !== pageRef.current.type) return null;
        // 不是本实例的快照（宿主自定义了 storageKey，或共享键已经换了主人）：整份不采信。
        // 必须在给 ref 灌值**之前**拦：下面那几行是「用户意图」，灌错了会带到每一次编译
        if (!propsRef.current.shareLayout && saved.scopeKey !== scopeKey(scopeRef.current)) return null;
        // 快照里的三份记账也各校验一次：畸形值不能污染 ref，否则后面每次编译都带着它
        dismissedRef.current = Array.isArray(saved.dismissed)
            ? saved.dismissed.filter((id) => typeof id === 'string')
            : [];
        maximizedRef.current = typeof saved.maximizedArea === 'string' ? saved.maximizedArea : null;
        pinnedRef.current = isSizeMap(saved.pinnedSizes) ? saved.pinnedSizes : {};
        sharesRef.current = isShareMap(saved.shares) ? saved.shares : {};
        movedRef.current = isIdMap(saved.movedViews) ? saved.movedViews : {};
        return saved;
    }, []);

    const applyLayout = useCallback((layout: CompiledLayout, maximizedArea: string | null) => {
        const api = apiRef.current;
        if (!api) return;
        applyingRef.current = true;
        try {
            // reuseExistingPanels：模板改了（加/删一个 view）时，没动的 panel 原样留着 ——
            // 不加的话 dockview 会先 `clear()` 全文重建，聊天流、打开的文件、选中的 tab 全部重来。
            api.fromJSON(toSerialized(layout), { reuseExistingPanels: true });
            // 收起/展开显式过一遍：dockview 的 fromJSON 对**组**的 visible 处理不可靠
            // （叶子上的 visible:false 在反序列化时组还没挂进 grid），这里按编译结果落定
            for (const state of Object.values(layout.areas)) {
                api.getGroup(state.id)?.api.setVisible(state.visible);
            }
            if (maximizedArea) {
                const group = api.getGroup(maximizedArea);
                const panel = group?.panels[0];
                if (panel) api.maximizeGroup(panel);
            }
            layoutRef.current = layout;
        } finally {
            applyingRef.current = false;
        }
    }, []);

    /** 此刻每组的实测渲染尺寸（只用来算拖动位移，不当作模板 px） */
    const measureGroups = useCallback((): Record<string, { width: number; height: number }> => {
        const out: Record<string, { width: number; height: number }> = {};
        for (const group of apiRef.current?.groups ?? []) {
            out[group.id] = { width: group.api.width, height: group.api.height };
        }
        return out;
    }, []);

    /**
     * 用户拖完分屏线 → 把「模板里写死数字」的区域按**这一次的位移**重新钉。
     *
     * 为什么记位移，而不是「实测 vs 重编」的差（那个写法有两个坑）：
     *   · dockview 渲染出来的宽高**不是**编译给它的 px：每组都被扣掉 `theme.gap` 的一份
     *     （`margin * sashCount / visibleCount`，默认主题 gap 10、三组就是每组 −6.7）。
     *     拿实测当模板值会记少一点，下次进来再少一批 —— 越拖越窄；
     *   · 容器缩放 / 收起展开 / 最大化 / 首次 fromJSON 之后都会来一条 geometry 事件，
     *     「实测 ≠ 重编」在这些情况下天然成立，但一条都不是用户的意思。
     *
     * 位移两个问题都没有：它只在 pointerdown（且按在 `.dv-sash` 上）到 pointerup 之间才有基准，
     * 而「上一次的逻辑尺寸 + Δ」正好把 gap 份额抵消掉。
     */
    const recordDraggedSizes = useCallback(() => {
        const before = dragBeforeRef.current;
        const api = apiRef.current;
        const viewport = sizeRef.current;
        // 没人拖分屏线 → 这条 geometry 不是用户改尺寸（也可能是 fromJSON 的余波）；
        // 最大化时尺寸全是失真的，一样不记
        if (!before || !api || !viewport || maximizedRef.current) return;

        let reference: CompiledLayout;
        try {
            // 和「此刻真实布局」用同一套输入（含 pinned / shares / moved），叶子集和逻辑尺寸才对得上
            reference = compileLayout({
                page: pageRef.current,
                views: viewsRef.current,
                scope: scopeRef.current,
                viewport,
                pinned: pinnedRef.current,
                shares: sharesRef.current,
                moved: movedRef.current,
            });
        } catch {
            return; // 此刻编不出来（view 还没注册齐）→ 这一次不记账
        }

        const axes = pinnedAreasRef.current;
        const leaves = leavesOf(reference.grid.root);
        const logical = new Map(leaves.map((leaf) => [leaf.data.id, leaf.size]));

        // 这一组的位移（px），按组自己的轴取：一个已经渲染出来的组才量得到
        const moveOf = (id: string): { dx: number; dy: number } | null => {
            const was = before[id];
            const group = api.getGroup(id);
            // 收起 / 最大化的组尺寸是失真的（~0 / 满屏），量它得到的"位移"没有意义
            if (!was || !group || !group.api.isVisible) return null;
            return {
                dx: Math.round(group.api.width - was.width),
                dy: Math.round(group.api.height - was.height),
            };
        };

        // ① px：模板里写死数字的区域。`leaf.size` 是这次编译的**逻辑**尺寸（已吃过 pinned），
        //    加上位移就是用户要的值
        const nextPinned = { ...pinnedRef.current };
        let changed = false;
        for (const leaf of leaves) {
            const axis = axes.get(leaf.data.id);
            if (!axis) continue; // 弹性区（`1fr` 永远是自动的，比例走 ②）/ 不是本页的叶子
            const moved = moveOf(leaf.data.id);
            if (!moved) continue;
            const delta = axis === 'x' ? moved.dx : moved.dy;
            if (delta === 0) continue; // 这一组没被拖到（同组其他分屏线动了它不算）
            const size = Math.max(0, Math.round(leaf.size + delta));
            if (size === pinnedRef.current[leaf.data.id]) continue;
            nextPinned[leaf.data.id] = size;
            changed = true;
        }

        // ② 比例：一组弹性区域（`1fr`）被拖过之后，把它们的**相对**份额重记一遍。
        //    px 钉不住它们（整组没有固定参照），比例可以 —— 换个窗口尺寸也成立。
        const nextShares = { ...sharesRef.current };
        for (const ids of leafGroups(reference.grid.root)) {
            const flex = ids.filter((id) => !axes.has(id));
            if (flex.length < 2) continue; // 只剩一个弹性成员时它总是吃剩下的，份额没意义
            const moves = ids.map((id) => moveOf(id));
            if (moves.some((moved) => !moved)) continue; // 有成员没渲染出来 → 整组不可靠，不记
            const dx = moves.reduce((acc, moved) => acc + Math.abs(moved!.dx), 0);
            const dy = moves.reduce((acc, moved) => acc + Math.abs(moved!.dy), 0);
            if (dx === 0 && dy === 0) continue; // 这组没被动
            // 拖的是分屏线，所以只有一个方向会真变；两个方向都变就是布局自己重排的余波，不记
            if (dx > 0 && dy > 0) continue;
            const horizontal = dx > 0;
            ids.forEach((id, index) => {
                if (axes.has(id)) return; // 数字区走 ①，这里只管弹性成员
                const moved = moves[index]!;
                const share = Math.max(1, Math.round((logical.get(id) ?? 0) + (horizontal ? moved.dx : moved.dy)));
                if (share === sharesRef.current[id]) return;
                nextShares[id] = share;
                changed = true;
            });
        }

        if (!changed) return;
        pinnedRef.current = nextPinned;
        sharesRef.current = nextShares;
        queuePersist();
    }, [queuePersist]);

    // ── 1. 量容器：compile 需要 viewport 才能把 `1fr` 落成 px ────────────────
    // 只用来把 sized 翻成 true（解尺寸不等于要重编）：之后容器怎么变都交给 dockview 自己重排，
    // 我们不 fromJSON —— 那会把所有 panel 重建一遍。
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (!rect) return;
            sizeRef.current = { width: rect.width, height: rect.height };
            if (rect.width > 0 && rect.height > 0) setSized(true);
        });
        observer.observe(host);

        // 尺寸记账的锈点：只有从分屏线（`.dv-sash`）上按下的拖动才算用户改尺寸。
        // 为什么不靠 `applying` 守卫：`onDidLayoutChange` 是 AsapEvent（microtask 合帧投递），
        // fromJSON 期间 fire 的事件会在同步守卫复位**之后**才送到我们手里 —— 同步标志看不见它。
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Element | null;
            const onSash = Boolean(target?.closest?.('.dv-sash'));
            // 新的一次交互开始：没按在分屏线上就清基准（上一次的 pointerup 可能被系统吞了，
            // 基准留到下一次拖动就变成一个很旧的幽灵值）
            dragBeforeRef.current = onSash ? measureGroups() : null;
        };
        const onPointerUp = () => {
            // 让 pointerup 之后那条 geometry 事件（microtask）先读完基准，再清掉
            requestAnimationFrame(() => {
                dragBeforeRef.current = null;
            });
        };
        host.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        window.addEventListener('blur', onPointerUp);
        return () => {
            observer.disconnect();
            host.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            window.removeEventListener('blur', onPointerUp);
        };
    }, [measureGroups]);

    // ── 2. 布局：首次用 storage 里的；之后（模板 / view / 页实例变了）用**当前**布局去合并 ──
    // 依赖只有 ready / sized / layoutKey。容器尺寸**不在**里面，对象身份也不在里面。
    useEffect(() => {
        if (!ready || !sized || !apiRef.current) return;
        const viewport = sizeRef.current;
        if (!viewport || viewport.width === 0 || viewport.height === 0) return;

        const attempt = (saved: SavedLayout | null): string | null => {
            try {
                const layout = resolveLayout({
                    page: pageRef.current,
                    views: viewsRef.current,
                    scope: scopeRef.current,
                    viewport,
                    saved,
                    shared: propsRef.current.shareLayout,
                });
                applyLayout(layout, saved?.maximizedArea ?? null);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        };

        const saves = appliedRef.current ? currentSaved() : loadSaved();
        let failure = attempt(saves);
        if (failure && saves) {
            // 快照坏了：丢掉它，用模板再来一次。这一页还能用，只是回到模板
            clearStored();
            dismissedRef.current = [];
            maximizedRef.current = null;
            pinnedRef.current = {};
            sharesRef.current = {};
            movedRef.current = {};
            failure = attempt(null);
        }
        appliedRef.current = true;
        setCrash(failure);
    }, [ready, sized, layoutKey, applyLayout, currentSaved, loadSaved, clearStored]);

    // 标题变了但布局没变 → 只改 tab 文案（否则标题这种小事会触发整棵树重建）
    useEffect(() => {
        const api = apiRef.current;
        if (!api || !appliedRef.current) return;
        for (const view of viewsRef.current) {
            const panel = api.getPanel(view.id);
            if (!panel) continue;
            panel.api.setTitle(viewTitle(view, scopeRef.current));
        }
    }, [titleKey]);

    /** 这个 view 此刻允许待在哪些区域（`area` 永远在内，`allow` 是额外清单）；不属于本页 → null */
    const allowedAreasOf = useCallback((viewId: string): Set<string> | null => {
        const view = viewsRef.current.find((candidate) => candidate.id === viewId);
        const placement = view && placementOf(view, pageRef.current.type);
        if (!placement) return null;
        return new Set([placement.area, ...(placement.allow ?? [])]);
    }, []);

    // ── 3. 记事件：布局变化存盘、关掉的 view、最大化 ──────────────────────────
    const onReady = useCallback(
        (event: DockviewReadyEvent) => {
            const api = event.api;
            apiRef.current = api;
            api.onDidLayoutChange((change) => {
                // geometry = 分屏线动了（也可能是容器缩放 / 收起展开 / 首帧 fromJSON 的余波，
                // 所以记账还要再过一道「用户真的在拖」的判断，见 recordDraggedSizes）
                if (change.reasons.has('geometry')) recordDraggedSizes();
                queuePersist();
            });
            api.onDidRemovePanel((panel) => {
                if (applyingRef.current) return;
                dismissedRef.current = [...new Set([...dismissedRef.current, panel.id])];
                queuePersist();
            });
            api.onDidMaximizedGroupChange((change) => {
                if (applyingRef.current) return;
                maximizedRef.current = change.isMaximized ? change.group.id : null;
                queuePersist();
            });
            api.onDidMovePanel(({ panel, to }) => {
                if (applyingRef.current) return;
                // L1 把 view 拖到了另一个区域：params 里的 areaId 得跟着走，否则 view 报的
                // 「我在哪个区域」从拖完那一刻就是假的
                const allowed = allowedAreasOf(panel.id);
                if (!allowed || !allowed.has(to.id)) return;
                panel.api.updateParameters({ areaId: to.id });
                // 拖出来的落点要进快照：否则下次进页它又回模板位置，L1 就成了「只能拖一次」
                const view = viewsRef.current.find((candidate) => candidate.id === panel.id);
                const declared = view && placementOf(view, pageRef.current.type)?.area;
                const next = { ...movedRef.current };
                if (declared && to.id === declared) delete next[panel.id];
                else next[panel.id] = to.id;
                movedRef.current = next;
                queuePersist();
            });
            api.onWillShowOverlay((event) => {
                // L1 的落点校验：`editable` 打开的是「能拖」，不是「能拖到任何地方」。
                // 拦在这里而不是拦在拖拽开始，是因为拖拽起点合法不代表终点合法。
                if (applyingRef.current || !propsRef.current.editable) return;
                const viewId = event.getData()?.panelId;
                if (!viewId) {
                    event.preventDefault(); // 拖的是整组：组没有 placement，也就没有落点
                    return;
                }
                const allowed = allowedAreasOf(viewId);
                const target = event.group?.id;
                // 只认「落在某个允许的区域里、当一个 tab」：top/left/… 会在模板之外新开一个区域
                if (!allowed || !target || !allowed.has(target) || event.position !== 'center') {
                    event.preventDefault();
                }
            });
            // 真正的首次布局在下面那个 effect 里（它要等 size 量到）；这里只翻 ready
            setReady(true);
        },
        [queuePersist, recordDraggedSizes, allowedAreasOf],
    );

    // ── 4. PageApi：view 手里的区域控制面 ─────────────────────────────────────
    const api = useMemo<PageApi>(() => {
        const withGroup = (areaId: string, fn: (group: NonNullable<ReturnType<DockviewApi['getGroup']>>) => void) => {
            const group = apiRef.current?.getGroup(areaId);
            if (group) fn(group);
        };
        /** view 在本页的 order（决定新 tab 插到第几位） */
        const orderOf = (viewId: string): number => {
            const view = viewsRef.current.find((candidate) => candidate.id === viewId);
            const placement = view && placementOf(view, pageRef.current.type);
            return placement?.order ?? 1000;
        };
        return {
            showArea: (areaId) => withGroup(areaId, (group) => group.api.setVisible(true)),
            hideArea: (areaId) => withGroup(areaId, (group) => group.api.setVisible(false)),
            toggleArea: (areaId) => withGroup(areaId, (group) => group.api.setVisible(!group.api.isVisible)),
            isAreaVisible: (areaId) => apiRef.current?.getGroup(areaId)?.api.isVisible ?? false,
            maximizeArea: (areaId) => {
                const dock = apiRef.current;
                if (!dock) return;
                if (!areaId) {
                    dock.exitMaximizedGroup();
                    return;
                }
                const panel = dock.getGroup(areaId)?.panels[0];
                if (panel) dock.maximizeGroup(panel);
            },
            isAreaMaximized: (areaId) => apiRef.current?.getGroup(areaId)?.api.isMaximized() ?? false,
            shared,
            skippedAreas: () => [...(layoutRef.current?.skippedAreas ?? [])],
            closeView: (viewId) => apiRef.current?.getPanel(viewId)?.api.close(),
            openView: (viewId) => {
                const dock = apiRef.current;
                const view = viewsRef.current.find((candidate) => candidate.id === viewId);
                if (!dock || !view) return false;
                const placement = placementOf(view, pageRef.current.type);
                if (!placement) return false; // 这个 view 不属于本页

                const existing = dock.getPanel(viewId);
                if (existing) {
                    existing.api.setActive();
                    return true;
                }

                // 拖过的 view 开回来时回到它拖去的地方（拖动落点持久化的另一半）
                const areaId = movedRef.current[viewId] ?? placement.area;
                const group = dock.getGroup(areaId);
                if (!group) return false; // 区域没落进布局（模板里删了 / 这个区域一个 view 都没落位）
                group.api.setVisible(true);

                // 关过的 view 再开回来：必须同时从 dismissed 里掸掉，
                // 否则下一次模板重编译又把它当成「用户关的」藏起来
                dismissedRef.current = dismissedRef.current.filter((id) => id !== viewId);

                const order = placement.order ?? 1000;
                const index = group.panels.filter((panel) => orderOf(panel.id) <= order).length;
                dock.addPanel({
                    id: viewId,
                    component: VIEW_COMPONENT,
                    title: viewTitle(view, scopeRef.current),
                    params: { viewId, areaId },
                    position: { referenceGroup: areaId, direction: 'within', index },
                });
                return true;
            },
            resetLayout: () => {
                dismissedRef.current = [];
                maximizedRef.current = null;
                pinnedRef.current = {};
                sharesRef.current = {};
                movedRef.current = {};
                clearStored();
                const viewport = sizeRef.current;
                if (!apiRef.current || !viewport) return;
                try {
                    applyLayout(
                        resolveLayout({
                            page: pageRef.current,
                            views: viewsRef.current,
                            scope: scopeRef.current,
                            viewport,
                            saved: null,
                        }),
                        null,
                    );
                    setCrash(null);
                } catch (error) {
                    setCrash(error instanceof Error ? error.message : String(error));
                }
            },
        };
    }, [applyLayout]);

    // 传给 view 的 props 走 context，不经过 dockview 的任何缓存：scope / page 一变，
    // 面板就重渲染 —— 但**布局**一点没动（对比：从前去改 deps 让它重建，代价是所有 panel 重挂）
    const pageContext = useMemo(() => ({ scope, page: pageInfo, api }), [scope, pageInfo, api]);

    // components 的身份必须**永远不变**：变了 dockview 会重挂所有 panel（内容全丢）
    const components = useMemo(() => {
        function ViewPanel(dockProps: IDockviewPanelProps): ReactElement | null {
            // hook 必须在任何 return 之前（view 找不到时也得跑，否则 hook 顺序会变）
            // Provider 在上面（包着 DockviewReact），所以面板能拿到实时的 scope；
            // 用 usePage 而不是直接读 ref —— 订阅上了才能在 props 变时重渲染
            const { scope: current, page, api: pageApi } = usePage<S>();
            const viewId = String(dockProps.params?.['viewId'] ?? '');
            const view = viewsRef.current.find((candidate) => candidate.id === viewId);
            if (!view) return null;
            const areaId = String(dockProps.params?.['areaId'] ?? '');
            // useMemo 不是为了性能：panel 因为 context 重渲染时，props 引用不变，
            // 非 React view 的 VanillaHost 就能靠 `===` 判断「没变，不必调 update」
            const viewProps = useMemo(
                () => ({ scope: current, page, api: pageApi, areaId }),
                [current, page, pageApi, areaId],
            );
            // 唯一的框架分叉点：react 走组件，vanilla 走命令式宿主（见 VanillaHost）
            if (view.render.kind === 'react') {
                const Component = view.render.component;
                return <Component {...viewProps} />;
            }
            return <VanillaHost create={view.render.create} viewProps={viewProps} />;
        }
        return { view: ViewPanel };
    }, []);

    return (
        <div ref={hostRef} className={className} style={{ width: '100%', height: '100%', position: 'relative' }}>
            <PageContext.Provider value={pageContext}>
                <DockviewReact
                    components={components}
                    onReady={onReady}
                    theme={theme}
                    // L0：结构锁死 —— 关掉拖拽换区与浮动组；分屏线、收起/展开、tab 仍然能用
                    disableDnd={!editable}
                    disableFloatingGroups={!editable}
                />
            </PageContext.Provider>
            {crash && (
                // 摆不出布局时盖一层说明：dockview 还挂着（「回到模板」要用它的 api）
                <div role="alert" style={crashStyle}>
                    <b>这一页没能摆出布局</b>
                    <code style={crashCodeStyle}>{crash}</code>
                    <button type="button" onClick={() => api.resetLayout()}>
                        回到模板
                    </button>
                </div>
            )}
        </div>
    );
}

const crashStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'var(--wb-crash-bg, #fff)',
    color: 'var(--wb-crash-fg, #333)',
    font: '13px/1.6 system-ui, sans-serif',
};

const crashCodeStyle: CSSProperties = {
    maxWidth: '80%',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--wb-crash-code, #b3261e)',
};

// ── 布局的内容签名 ────────────────────────────────────────────────────────
//
// 布局 effect 的依赖**只能是这些字符串**：调用方把 page / views / scope 写成内联对象是常态，
// 拿对象身份当依赖 = 每次渲染都 fromJSON 一遍 = 所有 panel 重挂、view 内部状态全丢。
// 这里只把**真的会改变布局**的东西编进去：
//   · 页实例身份（pageType + kind:id）—— 换页 = 换布局
//   · 区域树（id / 尺寸 / min / initial / hideHeader / 轴）
//   · 每个 view 的落位（area / primary / order）
// 标题、icon、render 怎么画**不算**（标题走 setTitle，内容走 context）。
function layoutSignature<S extends Scope>(page: PageDef<S>, views: readonly ViewDef<S>[], scope: Scope): string {
    const placed = views
        .map((view) => {
            const placement = placementOf(view, page.type);
            if (!placement) return null;
            return `${view.id}@${placement.area}:${placement.primary ? 1 : 0}:${placement.order ?? 1000}`;
        })
        .filter((entry): entry is string => entry !== null)
        .sort()
        .join(',');
    return [`${page.type}`, scopeKey(scope), areasSignature(page.areas), placed].join('\u0001');
}

function areasSignature(node: AreaNode): string {
    const own = `${String(node.size)}/${node.min ?? '-'}`;
    if (node.type === 'region') {
        return `${node.id}@${own}:${node.data.initial}:${node.data.hideHeader ? 1 : 0}`;
    }
    return `[${node.data.axis}:${own}:${node.data.children.map(areasSignature).join('|')}]`;
}

/** `pinnedSizes` 的形状检查：只收 string → 有限数字，其余一律当没有 */
function isSizeMap(value: unknown): value is Record<string, number> {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).every(([, size]) => typeof size === 'number' && Number.isFinite(size));
}

/** `shares` 的形状检查：只要 string → 正数（0 / 负数算不出比例，当没存过） */
function isShareMap(value: unknown): value is Record<string, number> {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).every(([, share]) => typeof share === 'number' && Number.isFinite(share) && share > 0);
}

/** `movedViews` 的形状检查：只要 string → string */
function isIdMap(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).every(([, id]) => typeof id === 'string' && id.length > 0);
}

// ── 非 React view 的宿主 ────────────────────────────────────────────────────
//
// 壳是 React，所以「props 变 → 通知 view」这活儿不用重写调度器：继续用 effect 驱动。
// 只做三件事：create 一次、props 变了调 update、卸载时 dispose。
//
// 两条不可违的约束：
//   1. create 只能跑一次 —— dockview 的 panel 建好后长期复用，重跑会丢 view 内部状态
//   2. dispose 必须幂等 —— StrictMode 会 mount → unmount → mount，每次都真的会调
//
// 已知边界（不打算用 adapter 拯救的）：
//   · 非 React view 内部的子树拿不到 usePage()，得自己往下传 props
//   · React 的错误边界 / Suspense 管不到它内部的异步，失败态自己画
function VanillaHost<S extends Scope>(props: {
    create: (props: ViewProps<S>) => VanillaView<S>;
    viewProps: ViewProps<S>;
}): ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const instanceRef = useRef<VanillaView<S> | null>(null);
    const lastPropsRef = useRef<ViewProps<S> | null>(null);
    const createRef = useRef(props.create);
    createRef.current = props.create;

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const instance = createRef.current(props.viewProps);
        instanceRef.current = instance;
        lastPropsRef.current = props.viewProps;
        host.appendChild(instance.element);
        return () => {
            instanceRef.current = null;
            lastPropsRef.current = null;
            instance.dispose?.();
            instance.element.remove();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 故意不写依赖数组：dockview 什么时候重渲染 panel 不由我们控制，每次渲染都把最新
    // props 递给 view，
    // 要不要真动 DOM 由 view 自己 diff。引用没变就不打扰它。
    useEffect(() => {
        if (!instanceRef.current) return;
        if (lastPropsRef.current === props.viewProps) return;
        lastPropsRef.current = props.viewProps;
        instanceRef.current.update?.(props.viewProps);
    });

    return <div ref={hostRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }} />;
}
