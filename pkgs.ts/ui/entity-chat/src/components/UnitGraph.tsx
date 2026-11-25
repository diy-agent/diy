// UnitGraph —— 任务页的「分解」视图：需求账本树的**只读**投影（缩进列表）。
//
// 为什么是树而不是图（2026-11-24 用户裁，2026-11-25 再收窄）：账本只回答「这件事要做成
// 哪些东西」。缩进树一行一个条目，一屏能读三十行，比任何画法都省地方；而「先做哪个、
// 一次做几条」是 bot 每轮自己挑的事，不进账本，也就不需要图来画。
//
// 曾经有过「依赖图」tab（deps 边 / 分层 / 批次虚框 / 兄弟串行标注）：那些是**排期**，
// 得人先排一遍、排完还得维护，图上先花的是人眼（11 个节点 26 条边实测）。整体删掉。
//
// 为什么只读（用户 2026-11-24 裁）：writer 只有 agent 的 `unit_*` 工具 —— 人在界面上直接勾选
// 会立刻产生「两边同时改树」的冲突语义（谁赢 / 怎么合并 / 撤销给谁看），目前没有这个需求。
// 要改就在聊天里说一句，agent 改完这里 5 秒内自己变。
import { roomTitle, type Room } from '../model';
import { useUnitBoard } from '../useUnitBoard';
import type { UnitItem } from '@diy-agent/chat-transport-rpc';

/** 状态符号：done 打勾、doing 半实心、母项 ▾、open 空心（能挑的是实心） */
function markOf(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return '✓';
    if (unit.status === 'doing') return '◐';
    if (unit.group) return '▾';
    return ready.has(unit.id) ? '●' : '○';
}

function rowClass(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return 'text-muted-foreground/60';
    if (unit.status === 'doing') return 'text-sky-500';
    if (unit.group) return 'text-foreground';
    return ready.has(unit.id) ? 'text-emerald-500' : 'text-muted-foreground';
}

export function UnitGraph({ room }: { room: Room }) {
    const { board, error } = useUnitBoard(room.id);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-muted-foreground">只有任务有内部拆分。</div>;
    }

    if (board === null) {
        return <div className="p-3 text-xs text-muted-foreground">{error ?? '读取中…'}</div>;
    }

    if (board.rows.length === 0) {
        return (
            <div className="flex h-full flex-col gap-2 p-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">还没有拆分</div>
                <p className="leading-relaxed">
                    跟 agent 说「把这件事拆成几步」，树会长在这里：缩进是母项 → 可验收的产出。
                    它每轮自己从「能挑的」里挑几条做，不用你排顺序。
                </p>
            </div>
        );
    }

    const ready = new Set(board.ready);
    return (
        <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{roomTitle(room)}</span>
                <span className="text-emerald-500">能挑 {board.ready.length}</span>
                <span className="text-sky-500">在做 {board.doing.length}</span>
                <span className="text-muted-foreground/70">完成 {board.done.length}</span>
                {board.groups.length > 0 && <span className="text-muted-foreground/70">母项 {board.groups.length}</span>}
            </div>
            <div className="flex flex-col gap-0.5">
                {board.rows.map((unit) => (
                    <div
                        key={unit.id}
                        className={`flex items-baseline gap-1.5 ${rowClass(unit, ready)}`}
                        style={{ paddingLeft: `${unit.depth * 14}px` }}
                    >
                        <span className="w-3 shrink-0 text-center">{markOf(unit, ready)}</span>
                        <code className="shrink-0 text-[10px] text-muted-foreground/80">{unit.id}</code>
                        <span
                            className={[
                                unit.status === 'done' ? 'line-through decoration-border' : '',
                                unit.group ? 'font-medium' : '',
                            ]
                                .join(' ')
                                .trim()}
                        >
                            {unit.title}
                        </span>
                    </div>
                ))}
            </div>
            {board.danglingParents.length > 0 && (
                <div className="text-[11px] text-amber-500">
                    悬空母项（数据异常，这些条目暂按顶层显示）：{board.danglingParents.join(' ')}
                </div>
            )}
            {error !== null && <div className="text-[11px] text-red-500">{error}</div>}
        </div>
    );
}
