// UnitDagView —— 任务页「依赖图」tab：unit DAG 的**有连线**版本（只读、可缩放）。
//
// 与「分解」tab 的分工：那个是按层排的文字列表（信息全、占地方少、扫一眼知道卡在哪）；
// 这个是同一份数据的图（依赖方向、并行分支、跨层长边一眼可见）。两者共用 `useUnitBoard`
// 与 `layoutUnits`，所以层号、状态色必然一致 —— 不一致会让人怀疑数据本身。
//
// 只读的理由与列表一致（写入口只有 agent 的 `unit_*` 工具）：人在图上拖一下就该改库，
// 会立刻带来「两边同时改图谁赢」的语义，目前没有这个需求。
//
// 为什么不用 React Flow 之类：见 `unitLayout.ts` 文件头与设计文档 §7 —— 只读小图不需要
// 拖拽/minimap/节点内嵌组件那一整套，而它的 CSS 会跟现有 tailwind/stylex 抢样式。
import * as React from 'react';

import { roomTitle, type Room } from '../model';
import {
    batchHulls,
    chainOf,
    clipTitle,
    edgePath,
    layoutUnits,
    type UnitItem,
    type UnitLayout,
} from '../unitLayout';
import { useUnitBoard } from '../useUnitBoard';

const MIN_K = 0.3;
const MAX_K = 2;

interface Camera {
    k: number;
    /** 平移（屏幕像素，作用在 CSS transform 上） */
    tx: number;
    ty: number;
}

/** 状态 → 配色。ready（可做）是派生的，不是 status，见 `toneOf`
 *
 * **只用语义 token + 半透明色**（`fill-card` / `stroke-border` / `fill-emerald-500/10`），
 * 因为页面是深色主题：写死的浅色（`fill-white` / `fill-zinc-50`）在深底上会变成一块亮斑，
 * 而浅灰的线压在近白的层带上对比度接近零 —— 看着就像「线段断了一截」。
 */
const TONE = {
    done: { box: 'fill-muted stroke-border', text: 'fill-muted-foreground' },
    doing: { box: 'fill-sky-500/10 stroke-sky-500', text: 'fill-sky-500' },
    ready: { box: 'fill-emerald-500/10 stroke-emerald-500', text: 'fill-emerald-500' },
    blocked: { box: 'fill-card stroke-border', text: 'fill-muted-foreground' },
} as const;

function toneOf(unit: UnitItem, ready: Set<string>): (typeof TONE)[keyof typeof TONE] {
    if (unit.status === 'done') return TONE.done;
    if (unit.status === 'doing') return TONE.doing;
    return ready.has(unit.id) ? TONE.ready : TONE.blocked;
}

/**
 * 批次配色。为什么不是状态色那种「语义色」：批次没有好坏之分，只是分组，
 * 所以取**页面自己的图表色板**（`--chart-1..5`，styles.css 里定义、随主题切换）——
 * 用 violet/amber 这类写死的调色板会在深色主题里比周围亮一挡，看着像贴上去的。
 * 按 batch id 排序后取模：同一批换了页面也是同一个颜色，不然刷一次就跳一个色，人记不住。
 */
const BATCH_TONES = [
    { hull: 'stroke-chart-1', tag: 'fill-chart-1', label: 'fill-chart-1' },
    { hull: 'stroke-chart-2', tag: 'fill-chart-2', label: 'fill-chart-2' },
    { hull: 'stroke-chart-3', tag: 'fill-chart-3', label: 'fill-chart-3' },
    { hull: 'stroke-chart-4', tag: 'fill-chart-4', label: 'fill-chart-4' },
    { hull: 'stroke-chart-5', tag: 'fill-chart-5', label: 'fill-chart-5' },
] as const;
const batchTone = (index: number): (typeof BATCH_TONES)[number] => BATCH_TONES[index % BATCH_TONES.length];

export function UnitDagView({ room }: { room: Room }) {
    const { board, error } = useUnitBoard(room.id);
    const layout: UnitLayout | null = React.useMemo(
        () => (board === null ? null : layoutUnits(board.rows)),
        [board],
    );

    // 批次虚框：跟着布局算（坐标只在这里算一次，组件里不再自己拼矩形）
    const hulls = React.useMemo(() => (layout === null ? [] : batchHulls(layout.nodes)), [layout]);
    const [camera, setCamera] = React.useState<Camera>({ k: 1, tx: 0, ty: 0 });
    const [hover, setHover] = React.useState<string | null>(null);
    const [picked, setPicked] = React.useState<string | null>(null);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const dragRef = React.useRef<{ x: number; y: number; tx: number; ty: number; k: number } | null>(null);
    const movedRef = React.useRef(0);

    // 新图（或画布尺寸变了）自动适配：缩放到看得清全貌，且不超过 1:1
    const width = layout?.width ?? 0;
    const height = layout?.height ?? 0;
    const fit = React.useCallback(() => {
        const el = wrapRef.current;
        if (el === null || width === 0 || height === 0) return;
        const k = Math.max(MIN_K, Math.min(1, (el.clientWidth - 16) / width, (el.clientHeight - 16) / height));
        setCamera({ k, tx: 0, ty: 0 });
    }, [width, height]);
    React.useEffect(() => fit(), [fit]);

    // 拖拽平移：**不用 setPointerCapture**。capture 会把后续 pointer 事件重定向到容器，
    // 节点的 onClick 就永远不来（第一版实测点节点不出详情卡）。改成 window 上监听，
    // 事件照常路由到节点，click 才能生效；拖动过 4px 才当拖拽，不算点选。
    React.useEffect(() => {
        const onMove = (event: PointerEvent): void => {
            const start = dragRef.current;
            if (start === null) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            movedRef.current = Math.max(movedRef.current, Math.abs(dx) + Math.abs(dy));
            setCamera({ k: start.k, tx: start.tx + dx, ty: start.ty + dy });
        };
        const onUp = (): void => {
            dragRef.current = null;
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, []);

    // 滚轮缩放：React 的 onWheel 是 passive（preventDefault 无效），必须手动绑
    React.useEffect(() => {
        const el = wrapRef.current;
        if (el === null) return;
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            const rect = el.getBoundingClientRect();
            const mx = event.clientX - rect.left;
            const my = event.clientY - rect.top;
            setCamera((prev) => {
                const k = Math.min(MAX_K, Math.max(MIN_K, prev.k * Math.exp(-event.deltaY * 0.0016)));
                const ratio = k / prev.k;
                // 让光标下的那一点不动
                return { k, tx: mx - (mx - prev.tx) * ratio, ty: my - (my - prev.ty) * ratio };
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
        // 依赖布局尺寸而不是 []：首帧还是「读取中…」（wrap 没挂载，ref 是 null），
        // 若只跑一次，listener 就永远绑不上（实测滚轮完全没反应）
    }, [width, height]);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-muted-foreground">只有任务有内部拆分。</div>;
    }
    if (board === null || layout === null) {
        return <div className="p-3 text-xs text-muted-foreground">{error ?? '读取中…'}</div>;
    }
    if (board.rows.length === 0) {
        return (
            <div className="flex h-full flex-col gap-2 p-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">还没有拆分</div>
                <p className="leading-relaxed">
                    跟 agent 说「把这件事拆成几步」，图会长在这里：节点是原子步（unit），箭头是「做完才能做」。
                </p>
            </div>
        );
    }

    const ready = new Set(board.ready);
    const focus = hover ?? picked;
    const chain = focus === null ? null : chainOf(board.rows, focus);
    const pickedRow = picked === null ? null : (board.rows.find((row) => row.id === picked) ?? null);
    const byId = new Map(board.rows.map((row) => [row.id, row]));
    const batchTitle = new Map((board.batches ?? []).map((batch) => [batch.id, batch.title]));
    // 节点角标查颜色用（不能 findIndex：找不到时返回 -1 → BATCH_TONES[-1] 是 undefined）
    const hullIndex = new Map(hulls.map((hull, index) => [hull.batch, index]));

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-2 pb-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{roomTitle(room)}</span>
                <span className="text-emerald-500">可做 {board.ready.length}</span>
                <span className="text-sky-500">在做 {board.doing.length}</span>
                <span>卡住 {board.blocked.length}</span>
                <span className="text-muted-foreground/70">完成 {board.done.length}</span>
                {hulls.length > 0 && <span className="text-muted-foreground/70">批次 {hulls.length}</span>}
                <span className="ml-auto flex items-center gap-2 text-[10px]">
                    <span className="flex items-center gap-1">
                        <span className="inline-block size-2 rounded-sm bg-emerald-500/10 ring-1 ring-emerald-500" />
                        可做
                    </span>
                    <span className="flex items-center gap-1">
                        <span className="inline-block size-2 rounded-sm bg-sky-500/10 ring-1 ring-sky-500" />
                        在做
                    </span>
                    <span className="flex items-center gap-1">
                        <span className="inline-block size-2 rounded-sm bg-muted ring-1 ring-border" />
                        完成
                    </span>
                    <button
                        type="button"
                        onClick={fit}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                    >
                        适配
                    </button>
                </span>
            </div>
            {board.cyclic && (
                <div className="mx-3 mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-500">
                    图里有环（数据异常）：环上的边按贪心临时反向画出，实际永远做不了。
                </div>
            )}
            <div
                ref={wrapRef}
                className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    dragRef.current = { x: event.clientX, y: event.clientY, tx: camera.tx, ty: camera.ty, k: camera.k };
                    movedRef.current = 0;
                }}
            >
                <svg
                    width={layout.width}
                    height={layout.height}
                    className="block select-none"
                    style={{ transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`, transformOrigin: '0 0' }}
                >
                    <defs>
                        <marker id="unit-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/60" />
                        </marker>
                        <marker
                            id="unit-arrow-active"
                            viewBox="0 0 10 10"
                            refX="9"
                            refY="5"
                            markerWidth="6"
                            markerHeight="6"
                            orient="auto"
                        >
                            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-sky-500" />
                        </marker>
                    </defs>

                    {/* 层带 + 层号：同层 = 可以并行做，这条信息靠「同一行」传达（TB 布局） */}
                    {layout.bands.map((band, index) => (
                        <g key={band.layer}>
                            {index % 2 === 1 && (
                                <rect
                                    x={4}
                                    y={band.y - 8}
                                    width={Math.max(layout.width - 8, 0)}
                                    height={band.height + 16}
                                    rx={4}
                                    className="fill-foreground/[0.04]"
                                />
                            )}
                            <text x={8} y={band.y - 12} fontSize={9} className="fill-muted-foreground/70">
                                {band.layer + 1}
                            </text>
                        </g>
                    ))}

                    {/* 批次虚框：画在边之下（线不能盖掉分组），标签贴框左上外侧（框内顶部是节点） */}
                    {hulls.map((hull, index) => {
                        const tone = batchTone(index);
                        const title = batchTitle.get(hull.batch) ?? '';
                        return (
                            <g key={`batch-${hull.batch}`}>
                                <rect
                                    x={hull.x}
                                    y={hull.y}
                                    width={hull.width}
                                    height={hull.height}
                                    rx={10}
                                    fill="none"
                                    strokeWidth={1.2}
                                    strokeDasharray="5 4"
                                    className={tone.hull}
                                >
                                    <title>
                                        {hull.batch} · {title}（{hull.members.length} 个 unit）
                                    </title>
                                </rect>
                                <text x={hull.x + 2} y={hull.y - 3} fontSize={9} className={tone.label}>
                                    {clipTitle(title === '' ? hull.batch : `${hull.batch} ${title}`, 22)}
                                </text>
                            </g>
                        );
                    })}

                    {layout.edges.map((edge) => {
                        const active = chain !== null && chain.has(edge.from) && chain.has(edge.to);
                        return (
                            <path
                                key={`${edge.from}->${edge.to}`}
                                d={edgePath(edge.points)}
                                fill="none"
                                strokeWidth={active ? 1.6 : 1}
                                markerEnd={`url(#${active ? 'unit-arrow-active' : 'unit-arrow'})`}
                                className={active ? 'stroke-sky-500' : 'stroke-muted-foreground/40'}
                            />
                        );
                    })}

                    {layout.nodes.map((node) => {
                        const tone = toneOf(node, ready);
                        const dim = chain !== null && !chain.has(node.id);
                        const tagIndex = node.batch === null ? undefined : hullIndex.get(node.batch);
                        return (
                            <g
                                key={node.id}
                                transform={`translate(${node.x}, ${node.y})`}
                                style={{ opacity: dim ? 0.25 : 1, cursor: 'pointer' }}
                                onPointerEnter={() => setHover(node.id)}
                                onPointerLeave={() => setHover(null)}
                                onClick={() => {
                                    if (movedRef.current > 4) return; // 拖动路过不算点选
                                    setPicked((prev) => (prev === node.id ? null : node.id));
                                }}
                            >
                                <rect
                                    x={-node.w / 2}
                                    y={-node.h / 2}
                                    width={node.w}
                                    height={node.h}
                                    rx={7}
                                    strokeWidth={picked === node.id ? 2 : 1.4}
                                    className={tone.box}
                                />
                                <text x={-node.w / 2 + 10} y={-2} fontSize={9} className="fill-muted-foreground/80 font-mono">
                                    {node.id}
                                </text>
                                <text x={-node.w / 2 + 10} y={13} fontSize={11.5} className={tone.text}>
                                    {clipTitle(node.title, 15)}
                                </text>
                                {tagIndex !== undefined && (
                                    // 角标：框重叠时靠它认人（虚框可能互相套住）
                                    <rect
                                        x={node.w / 2 - 13}
                                        y={-node.h / 2 + 6}
                                        width={7}
                                        height={7}
                                        rx={2}
                                        className={batchTone(tagIndex).tag}
                                    />
                                )}
                                <title>
                                    {node.id} · {node.title}
                                </title>
                            </g>
                        );
                    })}
                </svg>

                {pickedRow !== null && (
                    <div className="absolute right-2 bottom-2 w-64 rounded border border-border bg-popover/95 p-2 text-[11px] text-popover-foreground shadow-sm backdrop-blur">
                        <div className="flex items-baseline gap-1.5">
                            <code className="text-[10px] text-muted-foreground">{pickedRow.id}</code>
                            <span className="font-medium text-foreground">{pickedRow.title}</span>
                            <button
                                type="button"
                                className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
                                onClick={() => setPicked(null)}
                            >
                                关闭
                            </button>
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                            第 {pickedRow.layer + 1} 层 · {pickedRow.status === 'open' ? (ready.has(pickedRow.id) ? '可做' : '被挡') : pickedRow.status}
                            {' · '}
                            前置 {pickedRow.deps.length > 0 ? pickedRow.deps.join(' ') : '无'}
                            {' · '}
                            后继 {pickedRow.dependents.length > 0 ? pickedRow.dependents.join(' ') : '无'}
                            {pickedRow.batch !== null && (
                                <>
                                    {' · '}批次{' '}
                                    <code className="text-[10px] text-muted-foreground">{pickedRow.batch}</code>{' '}
                                    {batchTitle.get(pickedRow.batch) ?? ''}
                                </>
                            )}
                        </div>
                        {pickedRow.body.trim() !== '' && (
                            <p className="mt-1 max-h-32 overflow-auto leading-relaxed whitespace-pre-wrap text-foreground/80">
                                {pickedRow.body}
                            </p>
                        )}
                        {pickedRow.body.trim() === '' && <p className="mt-1 text-muted-foreground/70">（没有补充说明）</p>}
                    </div>
                )}
                {hover !== null && byId.get(hover) !== undefined && picked !== hover && (
                    <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-foreground/85 px-2 py-1 text-[10px] text-background">
                        {hover} · {byId.get(hover)!.title}
                    </div>
                )}
            </div>
        </div>
    );
}
