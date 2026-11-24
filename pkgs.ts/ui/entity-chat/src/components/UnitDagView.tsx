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
import { chainOf, clipTitle, edgePath, layoutUnits, type UnitItem, type UnitLayout } from '../unitLayout';
import { useUnitBoard } from '../useUnitBoard';

const MIN_K = 0.3;
const MAX_K = 2;

interface Camera {
    k: number;
    /** 平移（屏幕像素，作用在 CSS transform 上） */
    tx: number;
    ty: number;
}

/** 状态 → 配色。ready（可做）是派生的，不是 status，见 `toneOf` */
const TONE = {
    done: { box: 'fill-zinc-100 stroke-zinc-300', text: 'fill-zinc-400', line: 'stroke-zinc-200' },
    doing: { box: 'fill-sky-50 stroke-sky-400', text: 'fill-sky-700', line: 'stroke-sky-300' },
    ready: { box: 'fill-emerald-50 stroke-emerald-500', text: 'fill-emerald-800', line: 'stroke-emerald-300' },
    blocked: { box: 'fill-white stroke-zinc-300', text: 'fill-zinc-600', line: 'stroke-zinc-300' },
} as const;

function toneOf(unit: UnitItem, ready: Set<string>): (typeof TONE)[keyof typeof TONE] {
    if (unit.status === 'done') return TONE.done;
    if (unit.status === 'doing') return TONE.doing;
    return ready.has(unit.id) ? TONE.ready : TONE.blocked;
}

export function UnitDagView({ room }: { room: Room }) {
    const { board, error } = useUnitBoard(room.id);
    const layout: UnitLayout | null = React.useMemo(
        () => (board === null ? null : layoutUnits(board.rows)),
        [board],
    );

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
        return <div className="p-3 text-xs text-zinc-500">只有任务有内部拆分。</div>;
    }
    if (board === null || layout === null) {
        return <div className="p-3 text-xs text-zinc-500">{error ?? '读取中…'}</div>;
    }
    if (board.rows.length === 0) {
        return (
            <div className="flex h-full flex-col gap-2 p-3 text-xs text-zinc-500">
                <div className="font-medium text-zinc-600">还没有拆分</div>
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

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-2 pb-1 text-[11px] text-zinc-500">
                <span className="font-medium text-zinc-700">{roomTitle(room)}</span>
                <span className="text-emerald-700">可做 {board.ready.length}</span>
                <span className="text-sky-600">在做 {board.doing.length}</span>
                <span>卡住 {board.blocked.length}</span>
                <span className="text-zinc-400">完成 {board.done.length}</span>
                <span className="ml-auto flex items-center gap-2 text-[10px]">
                    <span className="flex items-center gap-1">
                        <span className="inline-block size-2 rounded-sm bg-emerald-100 ring-1 ring-emerald-500" />
                        可做
                    </span>
                    <span className="flex items-center gap-1">
                        <span className="inline-block size-2 rounded-sm bg-sky-100 ring-1 ring-sky-400" />
                        在做
                    </span>
                    <span className="flex items-center gap-1">
                        <span className="inline-block size-2 rounded-sm bg-zinc-100 ring-1 ring-zinc-300" />
                        完成
                    </span>
                    <button
                        type="button"
                        onClick={fit}
                        className="rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-50"
                    >
                        适配
                    </button>
                </span>
            </div>
            {board.cyclic && (
                <div className="mx-3 mb-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-600">
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
                            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-zinc-300" />
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
                                    className="fill-zinc-50/80"
                                />
                            )}
                            <text x={8} y={band.y - 12} fontSize={9} className="fill-zinc-400">
                                {band.layer + 1}
                            </text>
                        </g>
                    ))}

                    {layout.edges.map((edge) => {
                        const active = chain !== null && chain.has(edge.from) && chain.has(edge.to);
                        return (
                            <path
                                key={`${edge.from}->${edge.to}`}
                                d={edgePath(edge.points)}
                                fill="none"
                                strokeWidth={active ? 1.6 : 1}
                                markerEnd={`url(#${active ? 'unit-arrow-active' : 'unit-arrow'})`}
                                className={active ? 'stroke-sky-400' : 'stroke-zinc-300'}
                            />
                        );
                    })}

                    {layout.nodes.map((node) => {
                        const tone = toneOf(node, ready);
                        const dim = chain !== null && !chain.has(node.id);
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
                                <text x={-node.w / 2 + 10} y={-2} fontSize={9} className="fill-zinc-400 font-mono">
                                    {node.id}
                                </text>
                                <text x={-node.w / 2 + 10} y={13} fontSize={11.5} className={tone.text}>
                                    {clipTitle(node.title, 15)}
                                </text>
                                <title>
                                    {node.id} · {node.title}
                                </title>
                            </g>
                        );
                    })}
                </svg>

                {pickedRow !== null && (
                    <div className="absolute right-2 bottom-2 w-64 rounded border border-zinc-200 bg-white/95 p-2 text-[11px] shadow-sm backdrop-blur">
                        <div className="flex items-baseline gap-1.5">
                            <code className="text-[10px] text-zinc-400">{pickedRow.id}</code>
                            <span className="font-medium text-zinc-700">{pickedRow.title}</span>
                            <button
                                type="button"
                                className="ml-auto text-[10px] text-zinc-400 hover:text-zinc-600"
                                onClick={() => setPicked(null)}
                            >
                                关闭
                            </button>
                        </div>
                        <div className="mt-1 text-[10px] text-zinc-500">
                            第 {pickedRow.layer + 1} 层 · {pickedRow.status === 'open' ? (ready.has(pickedRow.id) ? '可做' : '被挡') : pickedRow.status}
                            {' · '}
                            前置 {pickedRow.deps.length > 0 ? pickedRow.deps.join(' ') : '无'}
                            {' · '}
                            后继 {pickedRow.dependents.length > 0 ? pickedRow.dependents.join(' ') : '无'}
                        </div>
                        {pickedRow.body.trim() !== '' && (
                            <p className="mt-1 max-h-32 overflow-auto leading-relaxed whitespace-pre-wrap text-zinc-600">
                                {pickedRow.body}
                            </p>
                        )}
                        {pickedRow.body.trim() === '' && <p className="mt-1 text-zinc-400">（没有补充说明）</p>}
                    </div>
                )}
                {hover !== null && byId.get(hover) !== undefined && picked !== hover && (
                    <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-zinc-800/85 px-2 py-1 text-[10px] text-white">
                        {hover} · {byId.get(hover)!.title}
                    </div>
                )}
            </div>
        </div>
    );
}
