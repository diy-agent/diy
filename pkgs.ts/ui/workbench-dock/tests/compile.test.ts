import { describe, expect, it } from 'vitest';
import {
    compileLayout,
    leavesOf,
    resolveLayout,
    summarize,
    type CompiledLayout,
    type DockNode,
    type SavedLayout,
} from '../src/compile.js';
import {
    area,
    col,
    definePage,
    defineView,
    ModelError,
    row,
    type PageDef,
    type Scope,
    type ViewDef,
} from '../src/model.js';

// 测试用最小 view：纯模型层不渲染，component 只占位
const stub = (() => null) as unknown as ViewDef['component'];

function view(id: string, areaId: string, extra: { primary?: boolean; order?: number } = {}): ViewDef {
    return defineView({
        id,
        title: id,
        placement: { 'task-run': { area: areaId, ...extra } },
        component: stub,
    });
}

const page: PageDef = definePage({
    type: 'task-run',
    title: (scope: Scope) => `任务 ${scope.title ?? scope.id}`,
    areas: col([
        row([
            area('left', { size: 300, min: 220 }),
            area('center', { size: '1fr', min: 360 }),
            area('right', { size: 320 }),
        ]),
        area('bottom', { size: 240, initial: 'collapsed' }),
    ]),
});

const scope: Scope = { kind: 'task', id: 't-1', title: '会话持久化' };
const viewport = { width: 1440, height: 900 };

const views = [
    view('chat', 'center', { primary: true }),
    view('detail', 'left'),
    view('members', 'right'),
    view('runs', 'bottom'),
];

describe('compileLayout', () => {
    it('区域树 → 布局：fr 落 px、initial:collapsed → visible:false、activeGroup 落在 primary 区', () => {
        const layout = compileLayout({ page, views, scope, viewport });

        expect(layout.pageId).toBe('task-run@task:t-1');
        expect(layout.title).toBe('任务 会话持久化');
        // 1440 = left 300 + center 820(1fr) + right 320
        expect(leavesOf(layout.grid.root).map((leaf) => [leaf.data.id, leaf.size, leaf.visible ?? true])).toEqual([
            ['left', 300, true],
            ['center', 820, true],
            ['right', 320, true],
            ['bottom', 240, false],
        ]);
        expect(layout.areas['center']?.activeView).toBe('chat');
        expect(layout.activeGroup).toBe('center');
        expect(layout.panels['chat']).toMatchObject({
            id: 'chat',
            contentComponent: 'view',
            params: { viewId: 'chat', areaId: 'center' },
        });
        // min 落成 dockview 的组约束
        expect(leavesOf(layout.grid.root)[0]?.data.constraints).toEqual({ minimumWidth: 220, minimumHeight: 220 });
    });

    it('同区域多 view：按 order 排 tab，primary 决定 activeView', () => {
        const layout = compileLayout({
            page,
            views: [view('b', 'center', { order: 20 }), view('a', 'center', { order: 10, primary: true })],
            scope,
            viewport,
        });
        expect(layout.areas['center']?.views).toEqual(['a', 'b']);
        expect(layout.areas['center']?.activeView).toBe('a');
        expect(leavesOf(layout.grid.root).map((leaf) => leaf.data.id)).toEqual(['center']);
    });

    it('没有 view 落位的区域被跳过（不报错，只是不占地方）', () => {
        const layout = compileLayout({ page, views: [view('chat', 'center')], scope, viewport });
        expect(layout.skippedAreas.sort()).toEqual(['bottom', 'left', 'right']);
        expect(summarize(layout.grid.root)).toBe('((center[chat]))');
    });

    it('页里一个 view 都没有 → 报错（空壳页没有意义）', () => {
        expect(() => compileLayout({ page, views: [view('chat', 'nowhere')], scope, viewport })).toThrow(ModelError);
        expect(() => compileLayout({ page, views: [], scope, viewport })).toThrow(/没有任何区域有 view 落位/);
    });
});

describe('definePage 校验', () => {
    it('轴必须交替（dockview 按深度决定方向，两层 row 表达不出来）', () => {
        expect(() => definePage({ type: 'x', title: 'x', areas: row([row([area('a')])]) })).toThrow(/交替/);
    });

    it('区域 id 唯一', () => {
        expect(() => definePage({ type: 'x', title: 'x', areas: col([area('a'), area('a')]) })).toThrow(/重复/);
    });
});

describe('resolveLayout（旧布局 × 新模板）', () => {
    const base = compileLayout({ page, views, scope, viewport });

    function saved(patch: (root: DockNode) => string[] = () => []): SavedLayout {
        const root = structuredClone(base.grid.root);
        const dismissed = patch(root);
        return {
            version: 1,
            pageType: 'task-run',
            scopeKey: 'task:t-1',
            dock: {
                grid: { ...base.grid, root },
                panels: base.panels,
                activeGroup: 'center',
            } as unknown as SavedLayout['dock'],
            dismissed,
        } as SavedLayout & { dock: SavedLayout['dock'] };
    }

    it('R1 保住用户拖过的尺寸、收起状态、tab 顺序', () => {
        const savedLayout = saved((root) => {
            const leaves = leavesOf(root);
            leaves.find((leaf) => leaf.data.id === 'left')!.size = 420;
            leaves.find((leaf) => leaf.data.id === 'bottom')!.visible = true; // 用户展开了作业区
            const right = leaves.find((leaf) => leaf.data.id === 'right')!;
            right.data.views = ['members'];
            return [];
        });
        const resolved = resolveLayout({ page, views, scope, viewport, saved: savedLayout });

        const leaves = leavesOf(resolved.grid.root);
        expect(leaves.map((leaf) => [leaf.data.id, leaf.size, leaf.visible ?? true])).toEqual([
            ['left', 420, true],
            ['center', 820, true],
            ['right', 320, true],
            ['bottom', 240, true],
        ]);
        expect(resolved.areas['bottom']?.visible).toBe(true);
    });

    it('R2/R4 新 view 插进它声明的区域，旧 tab 顺序不动', () => {
        const savedLayout = saved();
        const resolved = resolveLayout({
            page,
            views: [...views, view('notes', 'right', { order: 5 }), view('detail2', 'left', { order: 5 })],
            scope,
            viewport,
            saved: savedLayout,
        });
        expect(resolved.areas['right']?.views).toEqual(['members', 'notes']);
        expect(resolved.areas['left']?.views).toEqual(['detail', 'detail2']);
        // 新加的不会抢 activeView
        expect(resolved.areas['left']?.activeView).toBe('detail');
        expect(resolved.panels['notes']?.params?.['areaId']).toBe('right');
    });

    it('R3 模板删掉的区域直接丢弃，它的 view 也不再出现在 panels 里', () => {
        const smaller = definePage({ type: 'task-run', title: 'x', areas: row([area('center')]) });
        const resolved = resolveLayout({
            page: smaller,
            views: [view('chat', 'center')],
            scope,
            viewport,
            saved: saved(),
        });
        expect(Object.keys(resolved.areas)).toEqual(['center']);
        expect(Object.keys(resolved.panels).sort()).toEqual(['chat']);
    });

    it('用户关掉的 view 不自己回来（dismissed）', () => {
        const resolved = resolveLayout({ page, views, scope, viewport, saved: saved(() => ['runs']) });
        expect(resolved.areas['bottom']).toBeUndefined();
        expect(resolved.panels['runs']).toBeUndefined();
    });

    it('activeView 跟着旧布局走', () => {
        const savedLayout = saved((root) => {
            leavesOf(root).find((leaf) => leaf.data.id === 'center')!.data.activeView = 'chat';
            return [];
        });
        const resolved = resolveLayout({
            page,
            views: [view('chat', 'center'), view('notes', 'center', { order: 5, primary: true })],
            scope,
            viewport,
            saved: savedLayout,
        });
        expect(resolved.areas['center']?.views).toEqual(['chat', 'notes']);
        expect(resolved.areas['center']?.activeView).toBe('chat');
    });

    it('全都关掉 → 回到模板（不留空壳）', () => {
        const savedLayout = saved((root) => {
            for (const leaf of leavesOf(root)) leaf.data.views = [];
            return [];
        });
        const resolved = resolveLayout({ page, views, scope, viewport, saved: savedLayout });
        expect(Object.keys(resolved.areas).sort()).toEqual(['bottom', 'center', 'left', 'right']);
    });

    it('pageType 对不上（存的是别的页）→ 忽略快照，按模板编译', () => {
        const other: SavedLayout = { ...saved(), pageType: 'project' };
        const resolved: CompiledLayout = resolveLayout({ page, views, scope, viewport, saved: other });
        expect(summarize(resolved.grid.root)).toBe(summarize(base.grid.root));
    });
});
