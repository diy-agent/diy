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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { resolveLayout, toSerialized, type CompiledLayout, type SavedLayout, type Viewport } from '../compile.js';
import { pageId, pageTitle, type PageApi, type PageDef, type PageInfo, type Scope, type ViewDef } from '../model.js';
import { PageContext } from './context.js';

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
    /** 覆盖缺省存的键（缺省 `workbench-dock:<pageType>@<kind>:<id>`） */
    storageKey?: string;
    /** L1：允许拖 view 换区域（缺省 false = L0，只能拖分屏线 + 收起/展开 + 关/开 tab） */
    editable?: boolean;
    /** dockview 主题（缺省用它的内置浅色；暗色由宿主用 --dv-* 变量调） */
    theme?: DockviewTheme;
    className?: string;
    /** 每次布局变化（已节流到一帧） */
    onLayoutChange?(saved: SavedLayout): void;
}

export function PageWorkbench<S extends Scope>(props: PageWorkbenchProps<S>): ReactElement {
    const { page, views, scope, editable = false, theme, className } = props;

    // scope 常被调用方写成内联对象 → 按内容 memo，避免每次渲染都重编译布局
    const stableScope = useMemo(
        () => scope,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [scope.kind, scope.id, scope.title],
    );
    const pageInfo = useMemo<PageInfo>(
        () => ({
            type: page.type,
            id: pageId(page.type, stableScope),
            title: pageTitle(page, stableScope),
            icon: page.icon,
        }),
        [page, stableScope],
    );
    const storageKey = props.storageKey ?? `workbench-dock:${pageInfo.id}`;

    const hostRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<DockviewApi | null>(null);
    const appliedRef = useRef(false);
    const applyingRef = useRef(false);
    const dismissedRef = useRef<string[]>([]);
    const maximizedRef = useRef<string | null>(null);
    const saveFrameRef = useRef(0);
    const [size, setSize] = useState<Viewport | null>(null);
    /** dockview 实例就绪（onReady 已拿到 api） */
    const [ready, setReady] = useState(false);

    // view 外壳与 PageApi 都通过 ref 读最新值：dockview 的 components 必须身份稳定，
    // 重建会卸载所有 panel（React Compiler 下尤其容易踩）
    const viewsRef = useRef(views);
    viewsRef.current = views;
    const scopeRef = useRef(stableScope);
    scopeRef.current = stableScope;
    const pageInfoRef = useRef(pageInfo);
    pageInfoRef.current = pageInfo;
    const propsRef = useRef(props);
    propsRef.current = props;

    const currentSaved = useCallback((): SavedLayout | null => {
        const api = apiRef.current;
        if (!api) return null;
        return {
            version: 1,
            pageType: page.type,
            scopeKey: `${stableScope.kind}:${stableScope.id}`,
            dock: api.toJSON(),
            dismissed: dismissedRef.current,
            maximizedArea: maximizedRef.current ?? undefined,
        };
    }, [page.type, stableScope]);

    const persist = useCallback(() => {
        if (applyingRef.current) return;
        const saved = currentSaved();
        if (!saved) return;
        const { storage: store, onLayoutChange } = propsRef.current;
        store?.setItem(storageKey, JSON.stringify(saved));
        onLayoutChange?.(saved);
    }, [currentSaved, storageKey]);

    const queuePersist = useCallback(() => {
        if (saveFrameRef.current) return;
        saveFrameRef.current = requestAnimationFrame(() => {
            saveFrameRef.current = 0;
            persist();
        });
    }, [persist]);

    const loadSaved = useCallback((): SavedLayout | null => {
        const raw = propsRef.current.storage?.getItem(storageKey);
        if (!raw) return null;
        try {
            const saved = JSON.parse(raw) as SavedLayout;
            if (saved.version !== 1 || saved.pageType !== page.type) return null;
            dismissedRef.current = saved.dismissed ?? [];
            maximizedRef.current = saved.maximizedArea ?? null;
            return saved;
        } catch {
            return null;
        }
    }, [page.type, storageKey]);

    const applyLayout = useCallback((layout: CompiledLayout, maximizedArea: string | null) => {
        const api = apiRef.current;
        if (!api) return;
        applyingRef.current = true;
        try {
            api.fromJSON(toSerialized(layout));
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
        } finally {
            applyingRef.current = false;
        }
    }, []);

    // ── 1. 量容器：compile 需要 viewport 才能把 `1fr` 落成 px ────────────────
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (!rect) return;
            setSize((prev) =>
                prev && Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
                    ? prev
                    : { width: rect.width, height: rect.height },
            );
        });
        observer.observe(host);
        return () => observer.disconnect();
    }, []);

    // ── 2. 布局：首次用 storage 里的；之后（模板/view/scope 变了）用**当前**布局去合并 ──
    useEffect(() => {
        if (!ready || !apiRef.current || !size || size.width === 0 || size.height === 0) return;
        const saved = appliedRef.current ? currentSaved() : loadSaved();
        const layout = resolveLayout({ page, views, scope: stableScope, viewport: size, saved });
        applyLayout(layout, saved?.maximizedArea ?? null);
        appliedRef.current = true;
    }, [ready, size, page, views, stableScope, applyLayout, currentSaved, loadSaved]);

    // ── 3. 记事件：布局变化存盘、关掉的 view、最大化 ──────────────────────────
    const onReady = useCallback(
        (event: DockviewReadyEvent) => {
            const api = event.api;
            apiRef.current = api;
            api.onDidLayoutChange(() => queuePersist());
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
            // 真正的首次布局在下面那个 effect 里（它要等 size 量到）；这里只翻 ready
            setReady(true);
        },
        // 只建一次：后续变化走 effect
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    // ── 4. PageApi：view 手里的区域控制面 ─────────────────────────────────────
    const api = useMemo<PageApi>(() => {
        const withGroup = (areaId: string, fn: (group: NonNullable<ReturnType<DockviewApi['getGroup']>>) => void) => {
            const group = apiRef.current?.getGroup(areaId);
            if (group) fn(group);
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
            isAreaMaximized: () => apiRef.current?.hasMaximizedGroup() ?? false,
            closeView: (viewId) => apiRef.current?.getPanel(viewId)?.api.close(),
            resetLayout: () => {
                dismissedRef.current = [];
                maximizedRef.current = null;
                propsRef.current.storage?.removeItem(storageKey);
                if (apiRef.current && size) {
                    applyLayout(resolveLayout({ page, views, scope: stableScope, viewport: size, saved: null }), null);
                }
            },
        };
    }, [applyLayout, page, views, stableScope, size, storageKey]);

    // components 的身份必须**永远不变**：变了 dockview 会重挂所有 panel（内容全丢）
    const pageApiRef = useRef(api);
    pageApiRef.current = api;
    const components = useMemo(() => {
        function ViewPanel(dockProps: IDockviewPanelProps): ReactElement | null {
            const viewId = String(dockProps.params?.['viewId'] ?? '');
            const view = viewsRef.current.find((candidate) => candidate.id === viewId);
            if (!view) return null;
            const Component = view.component;
            const value = { scope: scopeRef.current, page: pageInfoRef.current, api: pageApiRef.current };
            return (
                <PageContext.Provider value={value}>
                    <Component
                        scope={scopeRef.current}
                        page={pageInfoRef.current}
                        areaId={String(dockProps.params?.['areaId'] ?? '')}
                        api={pageApiRef.current}
                    />
                </PageContext.Provider>
            );
        }
        return { view: ViewPanel };
    }, []);

    return (
        <div ref={hostRef} className={className} style={{ width: '100%', height: '100%' }}>
            <DockviewReact
                components={components}
                onReady={onReady}
                theme={theme}
                // L0：结构锁死 —— 关掉拖拽换区与浮动组；分屏线、收起/展开、tab 仍然能用
                disableDnd={!editable}
                disableFloatingGroups={!editable}
            />
        </div>
    );
}
