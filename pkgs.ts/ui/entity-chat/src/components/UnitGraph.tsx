// UnitGraph —— 任务页的「分解」视图：任务内部拆分树的**只读**投影（缩进列表）。
//
// 为什么是树而不是图（2026-11-24 用户裁）：图的信息密度低 —— 每个节点一个框 + 留白 + 文字被框
// 挤，20 个节点就要滚动；而缩进树一行一个节点，一屏能读三十行，还顺手把「谁在谁下面」表达完了。
// 图仍然在「依赖图」tab（`UnitDagView`）—— 需要看并行分支 / 跨域长边时才切过去。
//
// 树 = 分解（功能域 → 可验收的产出）；顺序不靠连线：**同父兄弟按书写顺序串行**，所以这里
// 只需要标出「它被谁挡着」。跨域依赖才值得单独标 `← 等 xxx`。
//
// 为什么只读（用户 2026-11-24 裁）：writer 只有 agent 的 `unit_*` 工具 —— 人在界面上直接勾选
// 会立刻产生「两边同时改图」的冲突语义（谁赢 / 怎么合并 / 撤销给谁看），目前没有这个需求。
// 要改就在聊天里说一句，agent 改完这里 5 秒内自己变。
import { roomTitle, type Room } from '../model';
import type { UnitBatchItem, UnitItem } from '../unitLayout';
import { useUnitBoard } from '../useUnitBoard';

/**
 * 批次的阶段颜色。只有 `review`（成员全做完、等人点头）值得抢眼 ——
 * 那是唯一一个「不催就卡着」的阶段；`accepted` 退成灰色（已经过去了）。
 */
function stageClass(stage: UnitBatchItem['stage']): string {
    if (stage === 'review') return 'bg-amber-100 text-amber-800';
    if (stage === 'active') return 'bg-sky-50 text-sky-700';
    if (stage === 'accepted') return 'bg-zinc-100 text-zinc-400';
    return 'bg-zinc-100 text-zinc-500';
}

/** 状态符号：done 打勾、doing 半实心、功能域 ▾、open 可做实心 / 不可做空心 */
function markOf(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return '✓';
    if (unit.status === 'doing') return '◐';
    if (unit.group) return '▾';
    return ready.has(unit.id) ? '●' : '○';
}

function rowClass(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return 'text-zinc-400';
    if (unit.status === 'doing') return 'text-sky-600';
    if (unit.group) return 'text-zinc-700';
    return ready.has(unit.id) ? 'text-emerald-700' : 'text-zinc-500';
}

export function UnitGraph({ room }: { room: Room }) {
    const { board, error } = useUnitBoard(room.id);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-zinc-500">只有任务有内部拆分。</div>;
    }

    if (board === null) {
        return <div className="p-3 text-xs text-zinc-500">{error ?? '读取中…'}</div>;
    }

    if (board.rows.length === 0) {
        return (
            <div className="flex h-full flex-col gap-2 p-3 text-xs text-zinc-500">
                <div className="font-medium text-zinc-600">还没有拆分</div>
                <p className="leading-relaxed">
                    跟 agent 说「把这件事拆成几步」，树会长在这里：缩进是功能域 → 可验收的产出，
                    同一层按书写顺序推进。
                </p>
            </div>
        );
    }

    const ready = new Set(board.ready);
    const titleOf = (id: string): string => board.rows.find((row) => row.id === id)?.title ?? '';
    // 批次是**正交**的一层：树不按批次分组（分组会拆散「谁在谁下面」），只在行尾标归属
    const batches = board.batches ?? [];
    const unbatched = board.rows.filter((row) => row.batch === null).length;
    return (
        <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                <span className="font-medium text-zinc-700">{roomTitle(room)}</span>
                <span className="text-emerald-700">可做 {board.ready.length}</span>
                <span className="text-sky-600">在做 {board.doing.length}</span>
                <span>卡住 {board.blocked.length}</span>
                <span className="text-zinc-400">完成 {board.done.length}</span>
                {board.groups.length > 0 && <span className="text-zinc-400">域 {board.groups.length}</span>}
            </div>
            {board.cyclic && (
                <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-600">
                    图里有环（数据异常）：这些 unit 永远做不了，需要 agent 拆边。
                </div>
            )}
            {batches.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[11px]">
                    <span className="text-zinc-400">批次</span>
                    {batches.map((batch) => (
                        <span
                            key={batch.id}
                            className={`rounded px-1.5 py-0.5 ${stageClass(batch.stage)}`}
                            title={batch.note === '' ? batch.title : `${batch.title}\n${batch.note}`}
                        >
                            <code className="text-[10px] opacity-70">{batch.id}</code> {batch.title}{' '}
                            {batch.doneCount}/{batch.total}
                            {batch.stage === 'review' && ' · 待验收'}
                            {batch.waitingOn.length > 0 &&
                                ` · 等 ${batch.waitingOn.map((id) => titleOf(id) || id).join('、')}`}
                        </span>
                    ))}
                    {unbatched > 0 && <span className="text-zinc-400">未分批 {unbatched}</span>}
                </div>
            )}
            <div className="flex flex-col gap-0.5">
                {board.rows.map((unit) => {
                    const holder = board.heldBy[unit.id];
                    // 跨域依赖才值得画出来；兄弟串行的「等」是默认行为，靠 holder 说一句就够
                    const crossDeps = unit.deps.filter((id) => {
                        const dep = board.rows.find((row) => row.id === id);
                        return dep !== undefined && dep.parent !== unit.parent;
                    });
                    return (
                        <div
                            key={unit.id}
                            className={`flex items-baseline gap-1.5 ${rowClass(unit, ready)}`}
                            style={{ paddingLeft: `${unit.depth * 14}px` }}
                        >
                            <span className="w-3 shrink-0 text-center">{markOf(unit, ready)}</span>
                            <code className="shrink-0 text-[10px] text-zinc-400">{unit.id}</code>
                            <span
                                className={[
                                    unit.status === 'done' ? 'line-through decoration-zinc-300' : '',
                                    unit.group ? 'font-medium' : '',
                                ]
                                    .join(' ')
                                    .trim()}
                            >
                                {unit.title}
                            </span>
                            {unit.batch !== null && (
                                <span className="shrink-0 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500">
                                    {unit.batch}
                                </span>
                            )}
                            {holder !== undefined && (
                                <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                                    ← 等 {titleOf(holder) || holder}
                                </span>
                            )}
                            {holder === undefined && crossDeps.length > 0 && (
                                <span className="ml-auto shrink-0 text-[10px] text-amber-600">
                                    ← 依赖 {crossDeps.map((id) => titleOf(id) || id).join('、')}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
            {error !== null && <div className="text-[11px] text-red-600">{error}</div>}
        </div>
    );
}
