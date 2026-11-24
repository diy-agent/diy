// UnitGraph —— 任务页的「分解」视图：任务内部 unit DAG 的**只读**投影。
//
// 为什么只读（用户 2026-11-24 裁）：图的 writer 只有 agent 的 `unit_*` 工具 —— 人在界面上
// 直接勾选会立刻产生「两边同时改图」的冲突语义（谁赢 / 怎么合并 / 撤销给谁看），而这件事
// 目前没有任何真实需求。要改就在聊天里说一句，agent 改完这里 5 秒内自己变。
//
// 为什么按**层**排而不是画自由连线的图：层的判据（同层之间无依赖）就是 DAG 的骨架，
// 一排排看下去天然回答了「现在卡在哪、下一步能并行做哪几条」；而节点上现在还没有
// worktree / PR 这些重信息，自由布局的连线只是装饰。等 batch 出现再考虑真图形。
import * as React from 'react';

import { roomTitle, type Room } from '../model';
import { diy2 } from '../store';

/** 一个 unit（与 `@diy-agent/entity-runtime` 的 `UnitBoardRow` 同形；UI 层不跨包拿类型） */
interface UnitItem {
    id: string;
    title: string;
    body: string;
    status: 'open' | 'doing' | 'done';
    deps: string[];
    dependents: string[];
    layer: number;
}

interface UnitBoard {
    rows: UnitItem[];
    ready: string[];
    doing: string[];
    blocked: string[];
    done: string[];
    layers: UnitItem[][];
    cyclic: boolean;
}

/** 状态符号：done 打勾、doing 半实心、open 空心（ready 的行另外上色） */
function markOf(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return '✓';
    if (unit.status === 'doing') return '◐';
    return ready.has(unit.id) ? '●' : '○';
}

function rowClass(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return 'text-zinc-400';
    if (unit.status === 'doing') return 'text-sky-600';
    return ready.has(unit.id) ? 'text-emerald-700' : 'text-zinc-500';
}

export function UnitGraph({ room }: { room: Room }) {
    const [board, setBoard] = React.useState<UnitBoard | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    // 轮询（和任务面板查 journal 同思路）：unit 只有 agent 写，不值得为它新开一种事件类型
    React.useEffect(() => {
        let alive = true;
        const load = (): void => {
            void diy2.units
                .list(room.id)
                .then((body) => {
                    if (alive) {
                        setBoard(body as UnitBoard);
                        setError(null);
                    }
                })
                .catch((cause: unknown) => {
                    if (alive) setError(cause instanceof Error ? cause.message : String(cause));
                });
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [room.id]);

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
                    跟 agent 说「把这件事拆成几步」，图会长在这里：节点是原子步（unit），边是「做完才能做」。
                </p>
            </div>
        );
    }

    const ready = new Set(board.ready);
    return (
        <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                <span className="font-medium text-zinc-700">{roomTitle(room)}</span>
                <span className="text-emerald-700">可做 {board.ready.length}</span>
                <span className="text-sky-600">在做 {board.doing.length}</span>
                <span>卡住 {board.blocked.length}</span>
                <span className="text-zinc-400">完成 {board.done.length}</span>
            </div>
            {board.cyclic && (
                <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-600">
                    图里有环（数据异常）：这些 unit 永远做不了，需要 agent 拆边。
                </div>
            )}
            {board.layers.map((layer, index) => (
                <div key={index} className="flex flex-col gap-0.5">
                    <div className="mt-1 text-[11px] text-zinc-400">层 {index + 1}</div>
                    {layer.map((unit) => (
                        <div key={unit.id} className={`flex items-baseline gap-1.5 ${rowClass(unit, ready)}`}>
                            <span className="w-3 shrink-0 text-center">{markOf(unit, ready)}</span>
                            <code className="shrink-0 text-[10px] text-zinc-400">{unit.id}</code>
                            <span className={unit.status === 'done' ? 'line-through decoration-zinc-300' : ''}>
                                {unit.title}
                            </span>
                            {unit.deps.length > 0 && (
                                <span className="ml-auto shrink-0 text-[10px] text-zinc-400">← {unit.deps.join(' ')}</span>
                            )}
                        </div>
                    ))}
                </div>
            ))}
            {error !== null && <div className="text-[11px] text-red-600">{error}</div>}
        </div>
    );
}
