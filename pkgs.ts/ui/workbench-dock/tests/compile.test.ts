import { describe, expect, it } from 'vitest';
import {
    compileLayout,
    leafGroups,
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

// 测试用最小 view：纯模型层不渲染，render 只占位（kind 合法即可，不图 tsc 之外的东西）
const stub: ViewDef['render'] = { kind: 'react', component: (() => null) as never };

function view(id: string, areaId: string, extra: { primary?: boolean; order?: number } = {}): ViewDef {
    return defineView({
        id,
        title: id,
        placement: { 'task-run': { area: areaId, ...extra } },
        render: stub,
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

    // 被跳过的区域**不占尺寸份额**：它的那一份如果留着，就成了一个洞，
    // dockview 的 proportionalLayout 会把活下来的组按比例放大去填 ——
    // 于是渲染尺寸和模板尺寸永久对不上（记账、min 约束、测试全跟着错）
    it('被跳过的区域不吃尺寸：活下来的组吃掉整份空间', () => {
        const sizes = (layout: CompiledLayout): [string, number][] =>
            leavesOf(layout.grid.root).map((leaf) => [leaf.data.id, leaf.size]);

        // row 里只剩 center → 它吃掉整个宽度（不是 1440-300-320）；根里只剩那行 → 吃掉整个高度
        expect(sizes(compileLayout({ page, views: [view('chat', 'center')], scope, viewport }))).toEqual([
            ['center', viewport.width],
        ]);
        // 只剩一个写在模板里的数字区也一样：留 300 的话右边会空出 1140 被放大填掉
        expect(sizes(compileLayout({ page, views: [view('detail', 'left')], scope, viewport }))).toEqual([
            ['left', viewport.width],
        ]);
        // 都在的时候一个像素不动（模板的数字照旧、fr 吃剩下的）
        expect(sizes(compileLayout({ page, views, scope, viewport }))).toEqual([
            ['left', 300],
            ['center', 820],
            ['right', 320],
            ['bottom', 240],
        ]);
    });

    // 全 `1fr` 的组没有固定参照：px 钉不住它，但比例能 —— 换个窗口尺寸也成立
    describe('shares（用户拖出来的比例）', () => {
        const even = definePage({
            type: 'task-run',
            title: 'x',
            areas: row([area('a', { size: '1fr' }), area('b', { size: '1fr' })]),
        });
        const sizes = (layout: CompiledLayout): [string, number][] =>
            leavesOf(layout.grid.root).map((leaf) => [leaf.data.id, leaf.size]);
        const both = [view('pa', 'a'), view('pb', 'b')];

        it('按份额分，不按模板的 fr（换窗口尺寸仍然是这个比例）', () => {
            expect(sizes(compileLayout({ page: even, views: both, scope, viewport, shares: { a: 1, b: 3 } }))).toEqual([
                ['a', 360],
                ['b', 1080],
            ]);
            // 同一份份额，窄一半的窗口：比例不变，px 重新算
            expect(
                sizes(
                    compileLayout({
                        page: even,
                        views: both,
                        scope,
                        viewport: { width: 720, height: 900 },
                        shares: { a: 1, b: 3 },
                    }),
                ),
            ).toEqual([
                ['a', 180],
                ['b', 540],
            ]);
        });

        it('份额不全就整组回模板（一半份额一半 fr 混不出可预测的结果）', () => {
            expect(sizes(compileLayout({ page: even, views: both, scope, viewport, shares: { a: 1 } }))).toEqual([
                ['a', 720],
                ['b', 720],
            ]);
            // 0 / 负数也当没记过
            expect(sizes(compileLayout({ page: even, views: both, scope, viewport, shares: { a: 0, b: 3 } }))).toEqual([
                ['a', 720],
                ['b', 720],
            ]);
        });

        it('和 pinned 分工：数字区钉 px，弹性区按份额分剩下的', () => {
            const mixed = definePage({
                type: 'task-run',
                title: 'x',
                areas: row([area('fixed', { size: 200 }), area('x', { size: '1fr' }), area('y', { size: '1fr' })]),
            });
            const three = [view('pf', 'fixed'), view('px', 'x'), view('py', 'y')];
            // 200 不动，剩下的 1240 按 1:3 分
            expect(
                sizes(compileLayout({ page: mixed, views: three, scope, viewport, shares: { x: 1, y: 3 } })),
            ).toEqual([
                ['fixed', 200],
                ['x', 310],
                ['y', 930],
            ]);
        });

        it('只认「整组都是叶子」的组（份额按区域 id 存，分支节点没有 id）', () => {
            const layout = compileLayout({ page, views, scope, viewport });
            expect(leafGroups(layout.grid.root)).toEqual([['left', 'center', 'right']]);
            // 单区域页：根本没有组
            expect(leafGroups(compileLayout({ page: even, views: [view('pa', 'a')], scope, viewport }).grid.root)).toEqual(
                [],
            );
        });
    });

    it('页里一个 view 都没有 → 报错（空壳页没有意义）', () => {
        expect(() => compileLayout({ page, views: [view('chat', 'nowhere')], scope, viewport })).toThrow(ModelError);
        expect(() => compileLayout({ page, views: [], scope, viewport })).toThrow(/没有任何区域有 view 落位/);
    });

    it('L1 的落点也验：`allow` 指向不存在的区域 → 报错（否则它是个黑洞）', () => {
        const drifting = defineView({
            id: 'chat',
            title: 'chat',
            placement: { 'task-run': { area: 'center', allow: ['left', 'nowhere'] } },
            render: stub,
        });
        expect(() => compileLayout({ page, views: [drifting], scope, viewport })).toThrow(/placement\.allow/);
    });

    it('`allow` 合法时不影响布局（它只回答「能被拖到哪」，不回答「摆在哪」）', () => {
        const drifting = defineView({
            id: 'chat',
            title: 'chat',
            placement: { 'task-run': { area: 'center', primary: true, allow: ['left'] } },
            render: stub,
        });
        expect(summarize(compileLayout({ page, views: [drifting], scope, viewport }).grid.root)).toBe(
            '((center[chat]))',
        );
    });

    it('L1 拖过的落点：在 `allow` 里就生效，不在就回模板位置（快照数据不可信）', () => {
        const drifting = defineView({
            id: 'chat',
            title: 'chat',
            placement: { 'task-run': { area: 'center', allow: ['left'] } },
            render: stub,
        });
        const moved = (target: string) =>
            summarize(compileLayout({ page, views: [drifting], scope, viewport, moved: { chat: target } }).grid.root);
        expect(moved('left')).toBe('((left[chat]))');
        expect(moved('right')).toBe('((center[chat]))'); // right 没声明过 → 当没拖过
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

    function saved(
        patch: (root: DockNode) => string[] = () => [],
        pinnedSizes?: Record<string, number>,
        shares?: Record<string, number>,
    ): SavedLayout {
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
            pinnedSizes,
            shares,
        } as SavedLayout & { dock: SavedLayout['dock'] };
    }

    const shape = (layout: CompiledLayout) =>
        leavesOf(layout.grid.root).map((leaf) => [leaf.data.id, leaf.size, leaf.visible ?? true]);

    it('R1 保住用户拖过的尺寸（pinnedSizes）、收起状态、tab 顺序', () => {
        const savedLayout = saved(
            (root) => {
                const leaves = leavesOf(root);
                leaves.find((leaf) => leaf.data.id === 'bottom')!.visible = true; // 用户展开了作业区
                leaves.find((leaf) => leaf.data.id === 'right')!.data.views = ['members'];
                return [];
            },
            { left: 420 },
        );
        const resolved = resolveLayout({ page, views, scope, viewport, saved: savedLayout });

        expect(shape(resolved)).toEqual([
            ['left', 420, true],
            ['center', 700, true], // 1fr 吃剩下：1440 - 420 - 320
            ['right', 320, true],
            ['bottom', 240, true],
        ]);
        expect(resolved.areas['bottom']?.visible).toBe(true);
    });

    it('快照里的 size 一律不采信：没 pinned 的区域按模板 + 当前 viewport 重算', () => {
        // 旧快照把 left 记成 500（那是上一次编译的产物，可能混着当时窗口尺寸）
        const stale = saved((root) => {
            leavesOf(root).find((leaf) => leaf.data.id === 'left')!.size = 500;
            return [];
        });
        expect(shape(resolveLayout({ page, views, scope, viewport, saved: stale }))).toEqual(shape(base));

        // 同一个钉住值，换个 viewport：固定区不动，1fr 重新分配
        const wide = saved(() => [], { left: 420 });
        const narrow = { width: 1000, height: 900 };
        expect(shape(resolveLayout({ page, views, scope, viewport: narrow, saved: wide }))).toEqual([
            ['left', 420, true],
            ['center', 260, true], // 1000 - 420 - 320
            ['right', 320, true],
            ['bottom', 240, false],
        ]);
    });

    it('pinnedSizes 不作用于 `1fr` 区域（它表达的就是「我不决定宽度」）', () => {
        const resolved = resolveLayout({ page, views, scope, viewport, saved: saved(() => [], { center: 500 }) });
        expect(shape(resolved)).toEqual(shape(base));
    });

    it('快照里的 shares 一样进编译：全弹性组按比例，且不碰数字区', () => {
        // 数字区只认 pinned：给它们递份额也没用（它们不是弹性的）
        const mixed = resolveLayout({
            page,
            views,
            scope,
            viewport,
            saved: saved(() => [], { left: 420 }, { center: 600, right: 200 }),
        });
        expect(shape(mixed)).toEqual([
            ['left', 420, true],
            ['center', 700, true],
            ['right', 320, true],
            ['bottom', 240, false],
        ]);

        // 全弹性组：份额决定分法；快照里那份「当时的 px」一律不采信
        const evenPage = definePage({
            type: 'task-run',
            title: 'x',
            areas: row([area('a', { size: '1fr' }), area('b', { size: '1fr' })]),
        });
        const evenViews = [view('pa', 'a'), view('pb', 'b')];
        const evenBase = compileLayout({ page: evenPage, views: evenViews, scope, viewport });
        const merged = resolveLayout({
            page: evenPage,
            views: evenViews,
            scope,
            viewport,
            saved: {
                version: 1,
                pageType: 'task-run',
                scopeKey: 'task:t-1',
                dock: {
                    grid: evenBase.grid,
                    panels: evenBase.panels,
                    activeGroup: 'a',
                } as unknown as SavedLayout['dock'],
                dismissed: [],
                shares: { a: 1, b: 3 },
            },
        });
        expect(shape(merged)).toEqual([
            ['a', 360, true],
            ['b', 1080, true],
        ]);
    });

    it('R2/R4 新 view 按 order 插进它声明的区域，旧 tab 的相对顺序不动', () => {
        const savedLayout = saved();
        const resolved = resolveLayout({
            page,
            views: [
                ...views,
                view('notes', 'right', { order: 5 }), // 比 members（缺省 1000）靠前
                view('detail2', 'left', { order: 5 }),
                view('later', 'right', { order: 2000 }), // 比 members 靠后
            ],
            scope,
            viewport,
            saved: savedLayout,
        });
        expect(resolved.areas['right']?.views).toEqual(['notes', 'members', 'later']);
        expect(resolved.areas['left']?.views).toEqual(['detail2', 'detail']);
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

    it('activeView 跟着旧布局走（新 view 就算写了 primary 也不抢）', () => {
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
        expect(resolved.areas['center']?.views).toEqual(['notes', 'chat']);
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

    // 快照是 localStorage 里的东西：用户手改过、旧版本写坏过、机器上装过别的版本。
    // 一律「当没存过」回模板，**绝不**把畸形树丢给 fromJSON（那是一条白屏 + 整页不可用的路）
    it('快照结构坏了 → 当没存过，按模板编译（不抛）', () => {
        const good = saved();
        const { grid } = good.dock as unknown as { grid: Record<string, unknown> };
        const broken: unknown[] = [
            { ...good, dock: { ...good.dock, grid: { ...grid, root: undefined } } },
            { ...good, dock: { ...good.dock, grid: { ...grid, root: 'root' } } },
            {
                ...good,
                dock: { ...good.dock, grid: { ...grid, root: { type: 'leaf', size: 1, data: { views: [] } } } },
            },
            {
                ...good,
                dock: {
                    ...good.dock,
                    grid: { ...grid, root: { type: 'leaf', size: 1, data: { id: 'center', views: 'nope' } } },
                },
            },
            { ...good, dock: { ...good.dock, grid: { ...grid, root: { type: 'branch', size: 1, data: [] } } } },
            { ...good, dock: { ...good.dock, grid: { ...grid, root: { type: 'weird', size: 1, data: null } } } },
            { ...good, dock: undefined },
        ];
        for (const snapshot of broken) {
            const resolved = resolveLayout({ page, views, scope, viewport, saved: snapshot as SavedLayout });
            expect(summarize(resolved.grid.root)).toBe(summarize(base.grid.root));
        }
        // dismissed 不是数组也不能把整次 resolve 带崩
        const dirty = { ...good, dismissed: 'oops' } as unknown as SavedLayout;
        expect(summarize(resolveLayout({ page, views, scope, viewport, saved: dirty }).grid.root)).toBe(
            '((left[detail] ; center[chat] ; right[members]) ; bottom[runs,hidden])',
        );
    });
});
